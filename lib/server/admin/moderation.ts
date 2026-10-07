/**
 * Leaderboard views for the admin (ADM-05, LB-07): the board as admins see it, with ids and
 * emails and the hidden entries; the winners with what Boustan needs to reach them and to judge
 * their run; and the runs the validator flagged.
 */
import type { Queryable } from "@/db/client";
import type { BestRunDoc } from "@/db/schema";
import { WINNERS, createLevel } from "@/game-core";
import { RANK_ORDER } from "../leaderboard";

export interface ModerationEntry {
  playerId: string;
  /** Position among visible entries; null while hidden. */
  rank: number | null;
  nickname: string | null;
  email: string;
  hidden: boolean;
  points: number;
  distanceM: number;
  garlic: number;
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
        points: b.points,
        distanceM: b.distanceM,
        garlic: b.garlic,
        achievedAt: b.achievedAt,
      },
    ];
  });
}

/**
 * The best runs at the top of the public board, in its order, hidden players left out: the
 * first `WINNERS` of them win if the contest ends now.
 */
export async function topBestRuns(q: Queryable, n: number = WINNERS): Promise<BestRunDoc[]> {
  const hidden = await q.players.find({ hidden: true }, { projection: { _id: 1 } }).toArray();
  return q.bestRuns
    .find(hidden.length > 0 ? { _id: { $nin: hidden.map((h) => h._id) } } : {})
    .sort(RANK_ORDER)
    .limit(n)
    .toArray();
}

/** Ids of the current winners: the top `WINNERS` players on the public board. */
export async function winnerIds(q: Queryable): Promise<string[]> {
  return (await topBestRuns(q)).map((b) => b._id);
}

export interface Winner extends Omit<ModerationEntry, "rank" | "hidden"> {
  rank: number;
  language: string;
  marketingOptIn: boolean;
  runId: string;
  /**
   * From the best run's own row, to judge whether a person played it. Null when the row is
   * missing.
   */
  activeMs: number | null;
  hits: number | null;
  /** Garlic the level put out up to the run's distance; collecting all of it is suspicious. */
  garlicAppeared: number | null;
}

/** The top `WINNERS` visible players, with their contact details and their best run's numbers. */
export async function winners(q: Queryable): Promise<Winner[]> {
  const best = await topBestRuns(q);
  const ids = best.map((b) => b._id);
  const owners = await q.players.find({ _id: { $in: ids } }).toArray();
  const runs = await q.runs.find({ _id: { $in: best.map((b) => b.runId) } }).toArray();
  const byId = new Map(owners.map((p) => [p._id, p]));
  const runOf = new Map(runs.map((r) => [r._id, r]));
  return best.flatMap((b, i) => {
    const p = byId.get(b._id);
    if (!p) return [];
    const run = runOf.get(b.runId);
    return [
      {
        playerId: p._id,
        rank: i + 1,
        nickname: p.nickname,
        email: p.email,
        language: p.language,
        marketingOptIn: p.marketingOptIn,
        points: b.points,
        distanceM: b.distanceM,
        garlic: b.garlic,
        achievedAt: b.achievedAt,
        runId: b.runId,
        activeMs: run?.activeMs ?? null,
        hits: run?.hits ?? null,
        garlicAppeared: run ? createLevel(run.seed).garlicSpawnedUpTo(run.distanceM) : null,
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
