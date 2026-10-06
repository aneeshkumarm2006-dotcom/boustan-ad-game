/**
 * Claims and "Save my score" (§15.3, RWD-03 to RWD-08, SEC-04, SEC-07, DATA-01 to DATA-03).
 *
 * One transaction does all of it: spend the claim token, upsert the player, write consent
 * rows, keep the best run, then for each unlocked reward check the switches and assign a code
 * with FOR UPDATE SKIP LOCKED, and queue the email and CRM rows. Either everything happens or
 * nothing does, so a failed claim can simply be retried.
 */
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import { claims, codes, emailOutbox, players, runs } from "@/db/schema";
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

  return q.transaction(async (tx): Promise<ClaimResult> => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, token.run)).for("update");
    if (!run || run.status !== "valid") return fail("rejected");

    const found = typed
      ? await lockOrCreatePlayer(tx, typed, input, run, now)
      : { player: await lockPlayer(tx, known!.id), created: false };
    if (!found.player) return fail("unknown_player");
    let player = found.player;

    // A spent token from the same player is a retry after a lost response: answer the same.
    if (run.claimedAt) {
      if (run.playerId !== player.id) return fail("expired");
      return {
        ok: true,
        response: {
          codes: await codesForRun(tx, run.id, player.id),
          alreadyClaimed: [],
          unavailable: [],
          playerToken: typed ? await issuePlayerToken(tx, player.id) : input.playerToken!,
          rank: await rankOfPlayer(tx, player.id),
        },
        playerId: player.id,
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
    [player] = await tx
      .update(players)
      .set({
        lastSeenAt: now,
        language: input.lang,
        ...(typed && !player.ageConfirmedAt ? { ageConfirmedAt: now } : {}),
        ...(optedIn ? { marketingOptIn: true } : {}),
        ...(typed && nickname ? { nickname } : {}),
        ...(!player.nickname && !nickname ? { nickname: autoNickname() } : {}),
      })
      .where(eq(players.id, player.id))
      .returning();

    const playerToken = typed ? await issuePlayerToken(tx, player.id) : input.playerToken!;
    const consentBase = {
      playerId: player.id,
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
        player.id,
        "consent_changed",
        { marketing: true, source: "claim_form" },
        `consent:${player.id}:${now.getTime()}:granted`,
      );
    }
    if (found.created) {
      await enqueueCrm(tx, player.id, "contact_upsert", { created: true }, `contact:${player.id}`);
    }

    // ---------- the run: spend its token, keep it as the best if it is ----------
    await tx.update(runs).set({ playerId: player.id, claimedAt: now }).where(eq(runs.id, run.id));
    await updateBestRun(tx, player.id, {
      runId: run.id,
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
      const prior = await claimOf(tx, player.id, reward);
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
      const [claim] = await tx
        .insert(claims)
        .values({
          playerId: player.id,
          rewardId: reward,
          runId: run.id,
          src: input.src,
          utm: input.utm,
          language: input.lang,
          createdAt: now,
        })
        .onConflictDoNothing({ target: [claims.playerId, claims.rewardId] })
        .returning({ id: claims.id });
      if (!claim) {
        // A concurrent claim with the same email got there first.
        alreadyClaimed.push(reward);
        alreadyClaimIds.push((await claimOf(tx, player.id, reward))!);
        continue;
      }
      const code = await assignCode(tx, reward, claim.id, now);
      if (!code) {
        await tx.delete(claims).where(eq(claims.id, claim.id));
        unavailable.push(reward);
        continue;
      }
      const expiresAt = codeExpiry(cfg, code.expiresAt, now);
      await tx.update(claims).set({ codeId: code.id, expiresAt }).where(eq(claims.id, claim.id));
      issued.push({ reward, code: code.code, expiresAt: expiresAt.toISOString() });
      newClaimIds.push(claim.id);
    }

    // ---------- email and CRM, in the same transaction (MAIL-05, CRM-05) ----------
    let emailId: string | null = null;
    if (newClaimIds.length > 0) {
      const [email] = await tx
        .insert(emailOutbox)
        .values({
          playerId: player.id,
          kind: "coupon",
          claimIds: newClaimIds,
          language: input.lang,
        })
        .returning({ id: emailOutbox.id });
      emailId = email.id;
      await enqueueCrm(
        tx,
        player.id,
        "reward_claimed",
        { rewards: issued.map((c) => c.reward), runId: run.id, src: input.src },
        `claim:${run.id}`,
      );
    }

    return {
      ok: true,
      response: {
        codes: issued,
        alreadyClaimed,
        unavailable,
        playerToken,
        rank: await rankOfPlayer(tx, player.id),
      },
      playerId: player.id,
      emailNormalized: player.emailNormalized,
      emailId,
      alreadyClaimIds,
      optedIn,
    };
  });
}

async function lockPlayer(tx: Tx, id: string): Promise<Player | null> {
  const [row] = await tx
    .select()
    .from(players)
    .where(and(eq(players.id, id), isNull(players.deletedAt)))
    .for("update");
  return row ?? null;
}

/** The player for a typed email, created on first claim. Locked for the rest of the claim. */
async function lockOrCreatePlayer(
  tx: Tx,
  typed: { email: string; normalized: string },
  input: ClaimInput,
  run: typeof runs.$inferSelect,
  now: Date,
): Promise<{ player: Player | null; created: boolean }> {
  const byEmail = () =>
    tx.select().from(players).where(eq(players.emailNormalized, typed.normalized)).for("update");
  const [existing] = await byEmail();
  if (existing) return { player: existing, created: false };
  const [created] = await tx
    .insert(players)
    .values({
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
    })
    .onConflictDoNothing({ target: players.emailNormalized })
    .returning();
  if (created) return { player: created, created: true };
  // Someone else created this player a moment ago; use theirs.
  const [raced] = await byEmail();
  return { player: raced ?? null, created: false };
}

async function claimOf(tx: Tx, playerId: string, reward: RewardId): Promise<string | null> {
  const [row] = await tx
    .select({ id: claims.id })
    .from(claims)
    .where(and(eq(claims.playerId, playerId), eq(claims.rewardId, reward)));
  return row?.id ?? null;
}

/**
 * Takes the oldest available code for the reward (RWD-03). SKIP LOCKED lets concurrent claims
 * each take a different row instead of queueing on the same one, and no code can be taken
 * twice: the row is locked until this transaction ends and is no longer 'available' after.
 */
async function assignCode(tx: Tx, reward: RewardId, claimId: string, now: Date) {
  const next = tx
    .select({ id: codes.id })
    .from(codes)
    .where(
      and(
        eq(codes.rewardId, reward),
        eq(codes.status, "available"),
        or(isNull(codes.expiresAt), gt(codes.expiresAt, now)),
      ),
    )
    .orderBy(codes.id)
    .limit(1)
    .for("update", { skipLocked: true });
  const [code] = await tx
    .update(codes)
    .set({ status: "assigned", claimId, assignedAt: now })
    .where(inArray(codes.id, next))
    .returning({ id: codes.id, code: codes.code, expiresAt: codes.expiresAt });
  return code ?? null;
}

/** Codes already issued from this run to this player, for an idempotent retry. */
async function codesForRun(tx: Tx, runId: string, playerId: string): Promise<IssuedCode[]> {
  const rows = await tx
    .select({ reward: claims.rewardId, code: codes.code, expiresAt: claims.expiresAt })
    .from(claims)
    .innerJoin(codes, eq(codes.id, claims.codeId))
    .where(and(eq(claims.runId, runId), eq(claims.playerId, playerId)));
  return rows
    .filter((r): r is typeof r & { reward: RewardId } => REWARD_IDS.includes(r.reward as RewardId))
    .map((r) => ({
      reward: r.reward,
      code: r.code,
      expiresAt: (r.expiresAt ?? new Date()).toISOString(),
    }));
}
