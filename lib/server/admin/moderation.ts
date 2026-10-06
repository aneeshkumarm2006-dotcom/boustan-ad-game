/**
 * Moderation views (ADM-05, LB-07): the board as admins see it, with ids and emails and the
 * hidden entries, and the runs the validator flagged.
 */
import type { Queryable } from "@/db/client";
import { RANK_ORDER } from "../leaderboard";

export interface ModerationEntry {
  playerId: string;
  /** Position among visible entries; null while hidden. */
  rank: number | null;
  nickname: string | null;
  email: string;
  hidden: boolean;
  garlic: number;
  hits: number;
  distanceM: number;
  achievedAt: Date;
}

/** Everyone with a best run in leaderboard order, hidden ones marked and unranked. */
export async function boardForModeration(q: Queryable, limit = 200): Promise<ModerationEntry[]> {
  const best = await q.bestRuns.find().sort(RANK_ORDER).limit(limit).toArray();
  const owners = await q.players
    .find({ _id: { $in: best.map((b) => b._id) }, deletedAt: null })
    .toArray();
  const byId = new Map(owners.map((p) => [p._id, p]));
  let rank = 0;
  return best.flatMap((b) => {
    const p = byId.get(b._id);
    if (!p) return [];
    return [
      {
        playerId: p._id,
        rank: p.hidden ? null : ++rank,
        nickname: p.nickname,
        email: p.email,
        hidden: p.hidden,
        garlic: b.garlic,
        hits: b.hits,
        distanceM: b.distanceM,
        achievedAt: b.achievedAt,
      },
    ];
  });
}

export interface FlaggedRun {
  id: string;
  finishedAt: Date;
  reason: string | null;
  distanceM: number;
  garlic: number;
  hits: number;
  activeMs: number;
  src: string | null;
  hostOrigin: string | null;
  clientVersion: string | null;
  playerId: string | null;
}

export async function flaggedRuns(q: Queryable, limit = 100): Promise<FlaggedRun[]> {
  const rows = await q.runs
    .find({ status: "flagged" })
    .sort({ finishedAt: -1 })
    .limit(limit)
    .toArray();
  return rows.map((r) => ({
    id: r._id,
    finishedAt: r.finishedAt,
    reason: r.flagReason,
    distanceM: r.distanceM,
    garlic: r.garlic,
    hits: r.hits,
    activeMs: r.activeMs,
    src: r.src,
    hostOrigin: r.hostOrigin,
    clientVersion: r.clientVersion,
    playerId: r.playerId,
  }));
}

/** Flag counts by reason over the last 7 days, for the summary strip. */
export async function flagSummary(
  q: Queryable,
  now = new Date(),
): Promise<{ reason: string; n: number }[]> {
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const rows = await q.runs
    .aggregate<{ _id: string | null; n: number }>([
      { $match: { status: "flagged", finishedAt: { $gt: since } } },
      { $group: { _id: "$flagReason", n: { $sum: 1 } } },
      { $sort: { n: -1, _id: 1 } },
    ])
    .toArray();
  return rows.map((r) => ({ reason: r._id ?? "unknown", n: r.n }));
}
