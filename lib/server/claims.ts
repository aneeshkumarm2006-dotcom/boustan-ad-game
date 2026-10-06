/**
 * Claims and "Save my score" (§15.3, RWD-03 to RWD-08, SEC-04, SEC-07, DATA-01 to DATA-03).
 *
 * One transaction does all of it: spend the claim token, upsert the player, write consent
 * rows, keep the best run, then for each unlocked reward check the switches and assign a code,
 * and queue the email and CRM rows. Either everything happens or nothing does, so a failed
 * claim can simply be retried.
 *
 * MongoDB gives each transaction a snapshot and lets the first writer of a document win: a
 * second transaction that writes the same player, run or code fails with a write conflict and
 * the driver runs it again, now seeing the winner's result. That is what keeps one claim per
 * player and reward, a claim token single-use, and a code from going to two players, without
 * row locks. The callback may therefore run more than once, so it has no effects outside the
 * database.
 */
import { randomInt } from "node:crypto";
import { insertOnce, type Db, type Tx } from "@/db/client";
import { newClaim, newEmailOutbox, newPlayer, type CodeDoc, type RunDoc } from "@/db/schema";
import { REWARD_IDS, unlockedRewards, type RewardId } from "@/game-core";
import type { Lang } from "@/i18n";
import type { ClaimResponse, IssuedCode } from "@/lib/api/types";
import { autoNickname, cleanNickname } from "@/lib/nicknames";
import type { Utm } from "@/lib/session";
import { claimsOpen, codeExpiry, loadCampaign, rewardRules } from "./campaign";
import { recordConsent } from "./consent";
import { enqueueCrm } from "./crm-outbox";
import { checkEmail } from "./email-address";
import { rankOfPlayer, updateBestRun } from "./leaderboard";
import { findPlayerByToken, issuePlayerToken, type Player } from "./players";
import { claimTokenSchema, verifyToken } from "./tokens";

export interface ClaimInput {
  claimToken: string;
  email?: string;
  playerToken?: string;
  nickname?: string;
  lang: Lang;
  termsAge: boolean;
  marketingOptIn: boolean;
  src: string | null;
  utm: Utm;
}

export interface ClaimContext {
  ip: string | null;
  userAgent: string | null;
  now: Date;
}

export type ClaimError = "expired" | "rejected" | "bad_email" | "unknown_player";

export interface ClaimSuccess {
  ok: true;
  response: ClaimResponse;
  playerId: string;
  /** Rate-limit key material for "already claimed" re-sends (MAIL-08). */
  emailNormalized: string;
  /** The coupon email queued for new codes, if any. */
  emailId: string | null;
  /** Earlier claims to re-send, subject to the resend limit (§3.4). */
  alreadyClaimIds: string[];
  /** Marketing consent was granted by this claim. */
  optedIn: boolean;
}

export type ClaimResult = ClaimSuccess | { ok: false; error: ClaimError };

const fail = (error: ClaimError): ClaimResult => ({ ok: false, error });

export async function claimRewards(
  q: Db,
  input: ClaimInput,
  ctx: ClaimContext,
): Promise<ClaimResult> {
  const { now } = ctx;
  const token = verifyToken("claim", input.claimToken, claimTokenSchema);
  if (!token) return fail("rejected");
  if (token.exp < now.getTime()) return fail("expired");

  // The form sends an email (also after "Not you?"); a one-tap claim sends only the token.
  let typed: { email: string; normalized: string } | null = null;
  let known: Player | null = null;
  if (input.email) {
    const check = checkEmail(input.email);
    if (!check.ok) return fail(check.reason === "disposable" ? "bad_email" : "rejected");
    if (!input.termsAge) return fail("rejected");
    typed = check;
  } else if (input.playerToken) {
    known = await findPlayerByToken(q, input.playerToken);
    if (!known) return fail("unknown_player");
  } else {
    return fail("rejected");
  }

  // How many times the transaction body has run: it runs again after a write conflict.
  let attempt = 0;
  return q.transaction(async (tx): Promise<ClaimResult> => {
    attempt++;
    const run = await tx.runs.findOne({ _id: token.run });
    if (!run || run.status !== "valid") return fail("rejected");

    const found = typed
      ? await lockOrCreatePlayer(tx, typed, input, run, now)
      : { player: await lockPlayer(tx, known!._id), created: false };
    if (!found.player) return fail("unknown_player");
    let player = found.player;

    // A spent token from the same player is a retry after a lost response: answer the same.
    if (run.claimedAt) {
      if (run.playerId !== player._id) return fail("expired");
      return {
        ok: true,
        response: {
          codes: await codesForRun(tx, run._id, player._id),
          alreadyClaimed: [],
          unavailable: [],
          playerToken: typed ? await issuePlayerToken(tx, player._id) : input.playerToken!,
          rank: await rankOfPlayer(tx, player._id),
        },
        playerId: player._id,
        emailNormalized: player.emailNormalized,
        emailId: null,
        alreadyClaimIds: [],
        optedIn: false,
      };
    }

    // ---------- player, device token, consent ----------
    const wasOptedIn = player.marketingOptIn;
    const optedIn = typed !== null && input.marketingOptIn && !wasOptedIn;
    const nickname = cleanNickname(input.nickname);
    player = (await tx.players.findOneAndUpdate(
      { _id: player._id },
      {
        $set: {
          lastSeenAt: now,
          language: input.lang,
          ...(typed && !player.ageConfirmedAt ? { ageConfirmedAt: now } : {}),
          ...(optedIn ? { marketingOptIn: true } : {}),
          ...(typed && nickname ? { nickname } : {}),
          ...(!player.nickname && !nickname ? { nickname: autoNickname() } : {}),
        },
      },
      { returnDocument: "after" },
    ))!;

    const playerToken = typed ? await issuePlayerToken(tx, player._id) : input.playerToken!;
    const consentBase = {
      playerId: player._id,
      lang: input.lang,
      source: "claim_form" as const,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      hostOrigin: run.hostOrigin,
    };
    if (typed) {
      await recordConsent(tx, { ...consentBase, kind: "terms_age", granted: true });
    }
    if (optedIn) {
      await recordConsent(tx, { ...consentBase, kind: "marketing", granted: true });
      await enqueueCrm(
        tx,
        player._id,
        "consent_changed",
        { marketing: true, source: "claim_form" },
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
    await tx.runs.updateOne({ _id: run._id }, { $set: { playerId: player._id, claimedAt: now } });
    await updateBestRun(tx, player._id, {
      runId: run._id,
      garlic: run.garlic,
      hits: run.hits,
      distanceM: run.distanceM,
      at: run.finishedAt,
    });

    // ---------- rewards ----------
    const campaign = await loadCampaign(tx, now);
    const unlocked = unlockedRewards(
      { distanceM: run.distanceM, garlic: run.garlic },
      rewardRules(run.rules),
    );
    const issued: IssuedCode[] = [];
    const alreadyClaimed: RewardId[] = [];
    const unavailable: RewardId[] = [];
    const newClaimIds: string[] = [];
    const alreadyClaimIds: string[] = [];

    for (const reward of REWARD_IDS.filter((id) => unlocked.includes(id))) {
      const prior = await claimOf(tx, player._id, reward);
      if (prior) {
        alreadyClaimed.push(reward);
        alreadyClaimIds.push(prior);
        continue;
      }
      const cfg = campaign.rewards[reward];
      if (!claimsOpen(campaign, now) || !cfg.active) {
        unavailable.push(reward);
        continue;
      }
      const claim = newClaim({
        playerId: player._id,
        rewardId: reward,
        runId: run._id,
        src: input.src,
        utm: input.utm,
        language: input.lang,
        createdAt: now,
      });
      const created = await insertOnce(
        tx.claims,
        { playerId: player._id, rewardId: reward },
        claim,
      );
      if (!created) {
        // A concurrent claim with the same email got there first.
        alreadyClaimed.push(reward);
        alreadyClaimIds.push((await claimOf(tx, player._id, reward))!);
        continue;
      }
      const code = await assignCode(tx, reward, claim._id, now, attempt);
      if (!code) {
        await tx.claims.deleteOne({ _id: claim._id });
        unavailable.push(reward);
        continue;
      }
      const expiresAt = codeExpiry(cfg, code.expiresAt, now);
      await tx.claims.updateOne({ _id: claim._id }, { $set: { codeId: code.id, expiresAt } });
      issued.push({ reward, code: code.code, expiresAt: expiresAt.toISOString() });
      newClaimIds.push(claim._id);
    }

    // ---------- email and CRM, in the same transaction (MAIL-05, CRM-05) ----------
    let emailId: string | null = null;
    if (newClaimIds.length > 0) {
      const email = newEmailOutbox({
        playerId: player._id,
        kind: "coupon",
        claimIds: newClaimIds,
        language: input.lang,
      });
      await tx.emailOutbox.insertOne(email);
      emailId = email._id;
      await enqueueCrm(
        tx,
        player._id,
        "reward_claimed",
        { rewards: issued.map((c) => c.reward), runId: run._id, src: input.src },
        `claim:${run._id}`,
      );
    }

    return {
      ok: true,
      response: {
        codes: issued,
        alreadyClaimed,
        unavailable,
        playerToken,
        rank: await rankOfPlayer(tx, player._id),
      },
      playerId: player._id,
      emailNormalized: player.emailNormalized,
      emailId,
      alreadyClaimIds,
      optedIn,
    };
  });
}

async function lockPlayer(tx: Tx, id: string): Promise<Player | null> {
  return tx.players.findOne({ _id: id, deletedAt: null });
}

/** The player for a typed email, created on first claim. */
async function lockOrCreatePlayer(
  tx: Tx,
  typed: { email: string; normalized: string },
  input: ClaimInput,
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

async function claimOf(tx: Tx, playerId: string, reward: RewardId): Promise<string | null> {
  const row = await tx.claims.findOne({ playerId, rewardId: reward }, { projection: { _id: 1 } });
  return row?._id ?? null;
}

/**
 * Takes the oldest available code for the reward (RWD-03): the lowest _id, which is the order
 * codes were imported in. One atomic update finds it and marks it assigned. If another
 * transaction took the same code first, this one fails with a write conflict and runs again,
 * so no code can be taken twice.
 *
 * Postgres's SKIP LOCKED let concurrent claims each take a different row. Here, claims that all
 * want the oldest code would conflict one round after another, and only one wins per round. So
 * once a transaction has had to run again, it picks at random among the oldest few available
 * codes, and the number doubles with each rerun: the claims spread out, and a burst of hundreds
 * settles in a handful of rounds. Order is only approximate under that kind of contention.
 */
async function assignCode(tx: Tx, reward: RewardId, claimId: string, now: Date, attempt: number) {
  const available = {
    rewardId: reward,
    status: "available",
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  };
  const take = { $set: { status: "assigned", claimId, assignedAt: now } };
  let code: CodeDoc | null = null;
  if (attempt > 1) {
    const oldest = await tx.codes
      .find(available, { projection: { _id: 1 } })
      .sort({ _id: 1 })
      .limit(2 ** Math.min(attempt, 12))
      .toArray();
    if (oldest.length === 0) return null;
    code = await tx.codes.findOneAndUpdate(
      { _id: oldest[randomInt(oldest.length)]._id, status: "available" },
      take,
      { returnDocument: "after" },
    );
  }
  code ??= await tx.codes.findOneAndUpdate(available, take, {
    sort: { _id: 1 },
    returnDocument: "after",
  });
  return code ? { id: code._id, code: code.code, expiresAt: code.expiresAt } : null;
}

/** Codes already issued from this run to this player, for an idempotent retry. */
async function codesForRun(tx: Tx, runId: string, playerId: string): Promise<IssuedCode[]> {
  const rows = await tx.claims.find({ runId, playerId, codeId: { $ne: null } }).toArray();
  const held = await tx.codes.find({ _id: { $in: rows.map((r) => r.codeId!) } }).toArray();
  const codeOf = new Map(held.map((c) => [c._id.toHexString(), c.code]));
  return rows
    .filter((r): r is typeof r & { rewardId: RewardId } =>
      REWARD_IDS.includes(r.rewardId as RewardId),
    )
    .filter((r) => codeOf.has(r.codeId!.toHexString()))
    .sort((a, b) => REWARD_IDS.indexOf(a.rewardId) - REWARD_IDS.indexOf(b.rewardId))
    .map((r) => ({
      reward: r.rewardId,
      code: codeOf.get(r.codeId!.toHexString())!,
      expiresAt: (r.expiresAt ?? new Date()).toISOString(),
    }));
}
