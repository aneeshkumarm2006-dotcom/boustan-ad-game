/**
 * "Save my score" (SEC-04, SEC-07, DATA-01 to DATA-03): how a new player gets onto the
 * leaderboard. The player gives an email (so Boustan can reach the winners) and an optional
 * nickname, confirms they are 14 or older, and may opt in to offers.
 *
 * One transaction does all of it: spend the save token, upsert the player, write the consent
 * rows, issue a device token, keep the run as the player's best, and queue the CRM rows. Either
 * everything happens or nothing does, so a failed save can simply be retried.
 *
 * MongoDB gives each transaction a snapshot and lets the first writer of a document win: a
 * second transaction that writes the same player or run fails with a write conflict and the
 * driver runs it again, now seeing the winner's result. That is what keeps a save token
 * single-use and one run from being credited to two players, without row locks. The callback may
 * therefore run more than once, so it has no effects outside the database.
 */
import { insertOnce, type Db, type Tx } from "@/db/client";
import { newPlayer, type RunDoc } from "@/db/schema";
import type { Lang } from "@/i18n";
import type { SaveScoreResponse } from "@/lib/api/types";
import { autoNickname, cleanNickname } from "@/lib/nicknames";
import type { Utm } from "@/lib/session";
import { boardOpen, loadCampaign } from "./campaign";
import { recordConsent } from "./consent";
import { enqueueCrm } from "./crm-outbox";
import { checkEmail } from "./email-address";
import { bestOf, rankOfPlayer, updateBestRun } from "./leaderboard";
import { issuePlayerToken, type Player } from "./players";
import { saveTokenSchema, verifyToken } from "./tokens";

export interface SaveInput {
  saveToken: string;
  email: string;
  nickname?: string;
  lang: Lang;
  termsAge: boolean;
  marketingOptIn: boolean;
  src: string | null;
  utm: Utm;
}

export interface SaveContext {
  ip: string | null;
  userAgent: string | null;
  now: Date;
}

export type SaveError = "expired" | "rejected" | "bad_email" | "closed";

export interface SaveSuccess {
  ok: true;
  response: SaveScoreResponse;
  playerId: string;
  /** Marketing consent was granted by this save. */
  optedIn: boolean;
}

export type SaveResult = SaveSuccess | { ok: false; error: SaveError };

const fail = (error: SaveError): SaveResult => ({ ok: false, error });

export async function saveScore(q: Db, input: SaveInput, ctx: SaveContext): Promise<SaveResult> {
  const { now } = ctx;
  const token = verifyToken("save", input.saveToken, saveTokenSchema);
  if (!token) return fail("rejected");
  if (token.exp < now.getTime()) return fail("expired");

  const typed = checkEmail(input.email);
  if (!typed.ok) return fail(typed.reason === "disposable" ? "bad_email" : "rejected");
  if (!input.termsAge) return fail("rejected");

  return q.transaction(async (tx): Promise<SaveResult> => {
    const run = await tx.runs.findOne({ _id: token.run });
    if (!run || run.status !== "valid") return fail("rejected");

    // Read fresh, so switching the leaderboard off stops saves at once.
    if (!boardOpen(await loadCampaign(tx), now)) return fail("closed");

    // A spent token from the same player is a retry after a lost response: answer the same.
    // Anyone else is refused here, before a player row is written for them: a refusal commits
    // the transaction, so a player created first would stay behind with no consent record.
    if (run.savedAt) {
      const owner = await tx.players.findOne({ emailNormalized: typed.normalized });
      if (!owner || run.playerId !== owner._id) return fail("expired");
      return {
        ok: true,
        response: {
          playerToken: await issuePlayerToken(tx, owner._id),
          rank: await rankOfPlayer(tx, owner._id),
          best: await bestOf(tx, owner._id),
        },
        playerId: owner._id,
        optedIn: false,
      };
    }

    const found = await lockOrCreatePlayer(tx, typed, input, run, now);
    if (!found.player) return fail("rejected");
    let player = found.player;

    // ---------- player, device token, consent ----------
    const optedIn = input.marketingOptIn && !player.marketingOptIn;
    const nickname = cleanNickname(input.nickname);
    player = (await tx.players.findOneAndUpdate(
      { _id: player._id },
      {
        $set: {
          lastSeenAt: now,
          language: input.lang,
          ...(!player.ageConfirmedAt ? { ageConfirmedAt: now } : {}),
          ...(optedIn ? { marketingOptIn: true } : {}),
          ...(nickname ? { nickname } : {}),
          ...(!player.nickname && !nickname ? { nickname: autoNickname() } : {}),
        },
      },
      { returnDocument: "after" },
    ))!;

    const playerToken = await issuePlayerToken(tx, player._id);
    const consentBase = {
      playerId: player._id,
      lang: input.lang,
      source: "save_form" as const,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      hostOrigin: run.hostOrigin,
    };
    await recordConsent(tx, { ...consentBase, kind: "terms_age" });
    if (optedIn) {
      await recordConsent(tx, { ...consentBase, kind: "marketing" });
      await enqueueCrm(
        tx,
        player._id,
        "consent_changed",
        { marketing: true, source: "save_form" },
        `consent:${player._id}:${now.getTime()}:granted`,
      );
    }
    if (found.created) {
      await enqueueCrm(
        tx,
        player._id,
        "contact_upsert",
        { created: true },
        `contact:${player._id}`,
      );
    }

    // ---------- the run: spend its token, keep it as the best if it is ----------
    await tx.runs.updateOne({ _id: run._id }, { $set: { playerId: player._id, savedAt: now } });
    await updateBestRun(tx, player._id, {
      runId: run._id,
      points: run.points,
      distanceM: run.distanceM,
      garlic: run.garlic,
      at: run.finishedAt,
    });

    return {
      ok: true,
      response: {
        playerToken,
        rank: await rankOfPlayer(tx, player._id),
        best: await bestOf(tx, player._id),
      },
      playerId: player._id,
      optedIn,
    };
  });
}

/** The player for a typed email, created on first save. */
async function lockOrCreatePlayer(
  tx: Tx,
  typed: { email: string; normalized: string },
  input: SaveInput,
  run: RunDoc,
  now: Date,
): Promise<{ player: Player | null; created: boolean }> {
  const existing = await tx.players.findOne({ emailNormalized: typed.normalized });
  if (existing) return { player: existing, created: false };
  const player = newPlayer({
    email: typed.email,
    emailNormalized: typed.normalized,
    nickname: cleanNickname(input.nickname) ?? autoNickname(),
    language: input.lang,
    ageConfirmedAt: now,
    marketingOptIn: false,
    firstSrc: run.src ?? input.src,
    firstHost: run.hostOrigin,
    utm: Object.keys(run.utm).length > 0 ? run.utm : input.utm,
    createdAt: now,
    lastSeenAt: now,
  });
  if (await insertOnce(tx.players, { emailNormalized: typed.normalized }, player)) {
    return { player, created: true };
  }
  // Someone else created this player a moment ago; use theirs.
  return {
    player: await tx.players.findOne({ emailNormalized: typed.normalized }),
    created: false,
  };
}
