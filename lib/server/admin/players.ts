/**
 * Admin player tools (ADM-04, ADM-05, DATA-07): search, one player's full record, export, hide
 * or rename on the leaderboard, and erase.
 *
 * Erasing removes the personal data (email, nickname, consent log with its IP addresses,
 * device tokens) and the leaderboard row, and keeps anonymous totals: the player row stays
 * with an anonymized address so runs still add up (DATA-07).
 */
import type { Db, Queryable } from "@/db/client";
import type { PlayerDoc } from "@/db/schema";
import { autoNickname } from "@/lib/nicknames";
import { isValidNickname } from "@/lib/email";

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
  /** Points of the player's best run; null without one. */
  bestPoints: number | null;
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
  const best = await q.bestRuns
    .find({ _id: { $in: rows.map((p) => p._id) } }, { projection: { points: 1 } })
    .toArray();
  const pointsOf = new Map(best.map((b) => [b._id, b.points]));
  return rows.map((p) => ({
    id: p._id,
    email: p.email,
    nickname: p.nickname,
    language: p.language,
    hidden: p.hidden,
    marketingOptIn: p.marketingOptIn,
    createdAt: p.createdAt,
    bestPoints: pointsOf.get(p._id) ?? null,
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
  const playerConsents = await q.consents
    .find({ playerId: id })
    .sort({ createdAt: -1, _id: -1 })
    .toArray();
  const devices = await q.playerTokens.countDocuments({ playerId: id });
  return {
    player,
    best,
    runs: playerRuns,
    consents: playerConsents,
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
      createdAt: player.createdAt,
      lastSeenAt: player.lastSeenAt,
    },
    bestRun: best
      ? {
          points: best.points,
          distanceM: best.distanceM,
          garlic: best.garlic,
          achievedAt: best.achievedAt,
          runId: best.runId,
        }
      : null,
    runs: detail.runs.map((r) => ({
      id: r._id,
      finishedAt: r.finishedAt,
      status: r.status,
      points: r.points,
      distanceM: r.distanceM,
      garlic: r.garlic,
      hits: r.hits,
      activeMs: r.activeMs,
      src: r.src,
      hostOrigin: r.hostOrigin,
      utm: r.utm,
    })),
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
    // Anonymizing first is also the claim on the player: a save running at the same moment
    // conflicts with this write and starts over, finding the player gone.
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
    return { consentRows: consents.deletedCount, devices: devices.deletedCount };
  });
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
