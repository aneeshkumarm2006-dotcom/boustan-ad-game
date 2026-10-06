/**
 * Admin player tools (ADM-04, ADM-05, DATA-07): search, one player's full record, resend a
 * coupon, export, hide or rename on the leaderboard, and erase.
 *
 * Erasing removes the personal data (email, nickname, consent log with its IP addresses,
 * device tokens) and the leaderboard row, and keeps anonymous totals: the player row stays
 * with an anonymized address so runs, claims and codes still add up (DATA-07).
 */
import { and, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Db, Queryable } from "@/db/client";
import {
  bestRuns,
  claims,
  codes,
  consents,
  crmOutbox,
  emailOutbox,
  playerTokens,
  players,
  runs,
} from "@/db/schema";
import { autoNickname } from "@/lib/nicknames";
import { isValidNickname } from "@/lib/email";
import { queueResend } from "../email/deliver";

export type PlayerRow = typeof players.$inferSelect;

/** Escapes % _ \ so a search term is matched literally. */
const like = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export interface PlayerSummary {
  id: string;
  email: string;
  nickname: string | null;
  language: string;
  hidden: boolean;
  marketingOptIn: boolean;
  createdAt: Date;
  claimCount: number;
}

/** Players whose email or nickname contains the term; the newest 50 when the term is empty. */
export async function searchPlayers(
  q: Queryable,
  term: string,
  limit = 50,
): Promise<PlayerSummary[]> {
  const t = term.trim().slice(0, 100);
  const rows = await q
    .select({
      id: players.id,
      email: players.email,
      nickname: players.nickname,
      language: players.language,
      hidden: players.hidden,
      marketingOptIn: players.marketingOptIn,
      createdAt: players.createdAt,
      // Written out in full: Drizzle drops table names inside a single-table select.
      claimCount: sql<number>`(select count(*)::int from claims c where c.player_id = players.id)`,
    })
    .from(players)
    .where(
      and(
        isNull(players.deletedAt),
        t ? or(ilike(players.email, like(t)), ilike(players.nickname, like(t))) : undefined,
      ),
    )
    .orderBy(desc(players.createdAt))
    .limit(limit);
  return rows;
}

export async function playerDetail(q: Queryable, id: string) {
  const [player] = await q.select().from(players).where(eq(players.id, id));
  if (!player) return null;
  const [best] = await q.select().from(bestRuns).where(eq(bestRuns.playerId, id));
  const playerRuns = await q
    .select()
    .from(runs)
    .where(eq(runs.playerId, id))
    .orderBy(desc(runs.finishedAt))
    .limit(50);
  const playerClaims = await q
    .select({
      id: claims.id,
      reward: claims.rewardId,
      code: codes.code,
      codeStatus: codes.status,
      expiresAt: claims.expiresAt,
      emailStatus: claims.emailStatus,
      src: claims.src,
      createdAt: claims.createdAt,
    })
    .from(claims)
    .leftJoin(codes, eq(codes.id, claims.codeId))
    .where(eq(claims.playerId, id))
    .orderBy(desc(claims.createdAt));
  const playerConsents = await q
    .select()
    .from(consents)
    .where(eq(consents.playerId, id))
    .orderBy(desc(consents.createdAt));
  const emails = await q
    .select({
      id: emailOutbox.id,
      kind: emailOutbox.kind,
      status: emailOutbox.status,
      attempts: emailOutbox.attempts,
      lastError: emailOutbox.lastError,
      createdAt: emailOutbox.createdAt,
      sentAt: emailOutbox.sentAt,
    })
    .from(emailOutbox)
    .where(eq(emailOutbox.playerId, id))
    .orderBy(desc(emailOutbox.createdAt))
    .limit(20);
  const [devices] = await q
    .select({ n: sql<number>`count(*)::int` })
    .from(playerTokens)
    .where(eq(playerTokens.playerId, id));
  return {
    player,
    best: best ?? null,
    runs: playerRuns,
    claims: playerClaims,
    consents: playerConsents,
    emails,
    devices: devices?.n ?? 0,
  };
}

/** Everything held about one player, as a JSON-able object (DATA-07). Token hashes left out. */
export async function exportPlayer(q: Queryable, id: string) {
  const detail = await playerDetail(q, id);
  if (!detail) return null;
  const { player } = detail;
  return {
    exportedAt: new Date().toISOString(),
    player: {
      id: player.id,
      email: player.email,
      nickname: player.nickname,
      language: player.language,
      marketingOptIn: player.marketingOptIn,
      hiddenFromLeaderboard: player.hidden,
      ageConfirmedAt: player.ageConfirmedAt,
      firstSrc: player.firstSrc,
      firstHost: player.firstHost,
      utm: player.utm,
      emailBlockedAt: player.emailBlockedAt,
      createdAt: player.createdAt,
      lastSeenAt: player.lastSeenAt,
    },
    bestRun: detail.best,
    runs: detail.runs.map((r) => ({
      id: r.id,
      finishedAt: r.finishedAt,
      status: r.status,
      distanceM: r.distanceM,
      garlic: r.garlic,
      hits: r.hits,
      activeMs: r.activeMs,
      src: r.src,
      hostOrigin: r.hostOrigin,
      utm: r.utm,
    })),
    claims: detail.claims,
    consents: detail.consents,
    emails: detail.emails,
  };
}

/**
 * Removes a player's personal data and leaderboard row (DATA-07, DATA-06), keeping anonymous
 * totals. Null when the player doesn't exist or is already erased.
 */
export async function erasePlayer(
  q: Db,
  id: string,
  now = new Date(),
): Promise<{ consentRows: number; devices: number } | null> {
  return q.transaction(async (tx) => {
    // The consent log refuses deletes unless the transaction says it is a purge.
    await tx.execute(sql`set local boustan.allow_consent_purge = 'on'`);
    const [player] = await tx
      .select({ id: players.id })
      .from(players)
      .where(and(eq(players.id, id), isNull(players.deletedAt)))
      .for("update");
    if (!player) return null;
    const gone = await tx
      .delete(consents)
      .where(eq(consents.playerId, id))
      .returning({ id: consents.id });
    const devices = await tx
      .delete(playerTokens)
      .where(eq(playerTokens.playerId, id))
      .returning({ h: playerTokens.tokenHash });
    await tx.delete(bestRuns).where(eq(bestRuns.playerId, id));
    await tx
      .update(crmOutbox)
      .set({ status: "skipped", lastError: "player erased" })
      .where(and(eq(crmOutbox.playerId, id), eq(crmOutbox.status, "pending")));
    await tx
      .update(emailOutbox)
      .set({ status: "blocked", lastError: "player erased", leaseUntil: null })
      .where(
        and(
          eq(emailOutbox.playerId, id),
          inArray(emailOutbox.status, ["pending", "retry", "sending"]),
        ),
      );
    await tx
      .update(players)
      .set({
        email: `erased-${id}@erased.invalid`,
        emailNormalized: `erased:${id}`,
        nickname: null,
        utm: {},
        ageConfirmedAt: null,
        marketingOptIn: false,
        hidden: false,
        crmStatus: "skipped",
        emailBlockedAt: now,
        emailBlockReason: "erased",
        deletedAt: now,
      })
      .where(eq(players.id, id));
    return { consentRows: gone.length, devices: devices.length };
  });
}

/** Queues a re-send of every code a player holds. Null when there is nothing to send. */
export async function queueCouponResend(q: Db, id: string): Promise<string | null> {
  const [player] = await q
    .select()
    .from(players)
    .where(and(eq(players.id, id), isNull(players.deletedAt)));
  if (!player || player.emailBlockedAt) return null;
  const owned = await q
    .select({ id: claims.id })
    .from(claims)
    .where(and(eq(claims.playerId, id), isNotNull(claims.codeId)));
  return queueResend(
    q,
    id,
    owned.map((c) => c.id),
    player.language,
    null,
  );
}

// ---------- leaderboard moderation (LB-07) ----------

export async function setHidden(q: Queryable, id: string, hidden: boolean): Promise<boolean> {
  const rows = await q
    .update(players)
    .set({ hidden })
    .where(and(eq(players.id, id), isNull(players.deletedAt)))
    .returning({ id: players.id });
  return rows.length > 0;
}

/**
 * Sets a name. An admin may pick any name that fits the format rules (the profanity filter is
 * for players); a blank name resets it to a new food name. Returns the name, or null when the
 * player is gone or the name isn't valid.
 */
export async function renamePlayer(
  q: Queryable,
  id: string,
  requested: string,
): Promise<string | null> {
  const typed = requested.normalize("NFC").trim().replace(/\s+/g, " ");
  if (typed !== "" && !isValidNickname(typed)) return null;
  const name = typed === "" ? autoNickname() : typed;
  const rows = await q
    .update(players)
    .set({ nickname: name })
    .where(and(eq(players.id, id), isNull(players.deletedAt)))
    .returning({ id: players.id });
  return rows.length > 0 ? name : null;
}
