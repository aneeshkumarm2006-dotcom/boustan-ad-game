/**
 * Admin player tools (ADM-04, ADM-05, DATA-07): search, one player's full record, resend a
 * coupon, export, hide or rename on the leaderboard, and erase.
 *
 * Erasing removes the personal data (email, nickname, consent log with its IP addresses,
 * device tokens) and the leaderboard row, and keeps anonymous totals: the player row stays
 * with an anonymized address so runs, claims and codes still add up (DATA-07).
 */
import type { Db, Queryable } from "@/db/client";
import type { PlayerDoc } from "@/db/schema";
import { autoNickname } from "@/lib/nicknames";
import { isValidNickname } from "@/lib/email";
import { queueResend } from "../email/deliver";

export type PlayerRow = PlayerDoc;

/** Escapes regex characters so a search term is matched literally. */
const literal = (term: string) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
  const match = { $regex: literal(t), $options: "i" };
  const rows = await q.players
    .find({ deletedAt: null, ...(t ? { $or: [{ email: match }, { nickname: match }] } : {}) })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
  const counts = await q.claims
    .aggregate<{ _id: string; n: number }>([
      { $match: { playerId: { $in: rows.map((p) => p._id) } } },
      { $group: { _id: "$playerId", n: { $sum: 1 } } },
    ])
    .toArray();
  const claimCount = new Map(counts.map((c) => [c._id, c.n]));
  return rows.map((p) => ({
    id: p._id,
    email: p.email,
    nickname: p.nickname,
    language: p.language,
    hidden: p.hidden,
    marketingOptIn: p.marketingOptIn,
    createdAt: p.createdAt,
    claimCount: claimCount.get(p._id) ?? 0,
  }));
}

export async function playerDetail(q: Queryable, id: string) {
  const player = await q.players.findOne({ _id: id });
  if (!player) return null;
  const best = await q.bestRuns.findOne({ _id: id });
  const playerRuns = await q.runs
    .find({ playerId: id })
    .sort({ finishedAt: -1 })
    .limit(50)
    .toArray();
  const claimRows = await q.claims.find({ playerId: id }).sort({ createdAt: -1 }).toArray();
  const held = await q.codes
    .find({ _id: { $in: claimRows.flatMap((c) => (c.codeId ? [c.codeId] : [])) } })
    .toArray();
  const codeOf = new Map(held.map((c) => [c._id.toHexString(), c]));
  const playerClaims = claimRows.map((c) => {
    const code = c.codeId ? codeOf.get(c.codeId.toHexString()) : undefined;
    return {
      id: c._id,
      reward: c.rewardId,
      code: code?.code ?? null,
      codeStatus: code?.status ?? null,
      expiresAt: c.expiresAt,
      emailStatus: c.emailStatus,
      src: c.src,
      createdAt: c.createdAt,
    };
  });
  const playerConsents = await q.consents
    .find({ playerId: id })
    .sort({ createdAt: -1, _id: -1 })
    .toArray();
  const emailRows = await q.emailOutbox
    .find({ playerId: id })
    .sort({ createdAt: -1 })
    .limit(20)
    .toArray();
  const emails = emailRows.map((e) => ({
    id: e._id,
    kind: e.kind,
    status: e.status,
    attempts: e.attempts,
    lastError: e.lastError,
    createdAt: e.createdAt,
    sentAt: e.sentAt,
  }));
  const devices = await q.playerTokens.countDocuments({ playerId: id });
  return {
    player,
    best,
    runs: playerRuns,
    claims: playerClaims,
    consents: playerConsents,
    emails,
    devices,
  };
}

/** Everything held about one player, as a JSON-able object (DATA-07). Token hashes left out. */
export async function exportPlayer(q: Queryable, id: string) {
  const detail = await playerDetail(q, id);
  if (!detail) return null;
  const { player, best } = detail;
  return {
    exportedAt: new Date().toISOString(),
    player: {
      id: player._id,
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
    bestRun: best
      ? {
          playerId: best._id,
          runId: best.runId,
          garlic: best.garlic,
          hits: best.hits,
          distanceM: best.distanceM,
          achievedAt: best.achievedAt,
        }
      : null,
    runs: detail.runs.map((r) => ({
      id: r._id,
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
    consents: detail.consents.map((c) => ({
      id: c._id.toHexString(),
      playerId: c.playerId,
      kind: c.kind,
      granted: c.granted,
      text: c.text,
      textVersion: c.textVersion,
      language: c.language,
      source: c.source,
      ip: c.ip,
      userAgent: c.userAgent,
      hostOrigin: c.hostOrigin,
      createdAt: c.createdAt,
    })),
    emails: detail.emails,
  };
}

/**
 * Removes a player's personal data and leaderboard row (DATA-07, DATA-06), keeping anonymous
 * totals. Null when the player doesn't exist or is already erased.
 *
 * This and the retention job (which calls it) are the only places that delete consent rows.
 */
export async function erasePlayer(
  q: Db,
  id: string,
  now = new Date(),
): Promise<{ consentRows: number; devices: number } | null> {
  return q.transaction(async (tx) => {
    // Anonymizing first is also the claim on the player: a claim or unsubscribe running at the
    // same moment conflicts with this write and starts over, finding the player gone.
    const player = await tx.players.findOneAndUpdate(
      { _id: id, deletedAt: null },
      {
        $set: {
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
        },
      },
      { projection: { _id: 1 } },
    );
    if (!player) return null;
    const consents = await tx.consents.deleteMany({ playerId: id });
    const devices = await tx.playerTokens.deleteMany({ playerId: id });
    await tx.bestRuns.deleteOne({ _id: id });
    await tx.crmOutbox.updateMany(
      { playerId: id, status: "pending" },
      { $set: { status: "skipped", lastError: "player erased" } },
    );
    await tx.emailOutbox.updateMany(
      { playerId: id, status: { $in: ["pending", "retry", "sending"] } },
      { $set: { status: "blocked", lastError: "player erased", leaseUntil: null } },
    );
    return { consentRows: consents.deletedCount, devices: devices.deletedCount };
  });
}

/** Queues a re-send of every code a player holds. Null when there is nothing to send. */
export async function queueCouponResend(q: Db, id: string): Promise<string | null> {
  const player = await q.players.findOne({ _id: id, deletedAt: null });
  if (!player || player.emailBlockedAt) return null;
  const owned = await q.claims
    .find({ playerId: id, codeId: { $ne: null } }, { projection: { _id: 1 } })
    .toArray();
  return queueResend(
    q,
    id,
    owned.map((c) => c._id),
    player.language,
    null,
  );
}

// ---------- leaderboard moderation (LB-07) ----------

export async function setHidden(q: Queryable, id: string, hidden: boolean): Promise<boolean> {
  const result = await q.players.updateOne({ _id: id, deletedAt: null }, { $set: { hidden } });
  return result.matchedCount > 0;
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
  const result = await q.players.updateOne(
    { _id: id, deletedAt: null },
    { $set: { nickname: name } },
  );
  return result.matchedCount > 0 ? name : null;
}
