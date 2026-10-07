/**
 * Best runs and ranks (LB-01 to LB-03). Order: most points, then whoever got there first. The
 * top WINNERS entries win. Only players with an email have a row, and hidden or deleted players
 * don't count.
 *
 * Hidden players are few, so every query looks them up and leaves them out by id. A deleted
 * player never has a row here: erasing one removes it in the same transaction (DATA-07).
 */
import type { Filter } from "mongodb";
import type { Queryable } from "@/db/client";
import type { BestRunDoc } from "@/db/schema";
import type { RunScore } from "@/game-core";
import type { LeaderboardEntry } from "@/lib/api/types";

/** The LB-01 order. The player id (`_id`) makes it total; best_runs_points_idx serves it. */
export const RANK_ORDER = { points: -1, achievedAt: 1, _id: 1 } as const;

/** best_runs rows that rank strictly above `s`, before tie-breaks. */
const above = (s: Pick<RunScore, "points">): Filter<BestRunDoc> => ({ points: { $gt: s.points } });

const same = (s: Pick<RunScore, "points">): Filter<BestRunDoc> => ({ points: s.points });

/** Ids of the players moderated off the board. */
async function hiddenIds(q: Queryable): Promise<string[]> {
  const rows = await q.players.find({ hidden: true }, { projection: { _id: 1 } }).toArray();
  return rows.map((r) => r._id);
}

const except = (ids: string[]): Filter<BestRunDoc> =>
  ids.length > 0 ? { _id: { $nin: ids } } : {};

/**
 * Keeps the player's best validated run (LB-02). Only a strictly better run replaces it. One
 * atomic update decides: with no row yet it inserts, with one it compares inside the database,
 * so two runs finishing at once can't overwrite a better score with a worse one.
 */
export async function updateBestRun(
  q: Queryable,
  playerId: string,
  run: RunScore & { runId: string; at: Date },
): Promise<void> {
  const next = {
    runId: run.runId,
    points: run.points,
    distanceM: run.distanceM,
    garlic: run.garlic,
    achievedAt: run.at,
  };
  const better = {
    $or: [{ $eq: [{ $type: "$points" }, "missing"] }, { $gt: [run.points, "$points"] }],
  };
  await q.bestRuns.updateOne(
    { _id: playerId },
    [
      {
        $replaceWith: {
          $cond: [better, { $mergeObjects: [{ _id: "$_id" }, { $literal: next }] }, "$$ROOT"],
        },
      },
    ],
    { upsert: true },
  );
}

export async function bestOf(q: Queryable, playerId: string): Promise<RunScore | null> {
  return q.bestRuns.findOne<RunScore>(
    { _id: playerId },
    { projection: { _id: 0, points: 1, distanceM: 1, garlic: 1 } },
  );
}

/**
 * The rank a new score would get now (results preview). Equal scores already on the board got
 * there first, so they stay ahead.
 */
export async function rankPreview(
  q: Queryable,
  score: Pick<RunScore, "points">,
  exceptPlayerId: string | null,
): Promise<number> {
  const skip = await hiddenIds(q);
  if (exceptPlayerId) skip.push(exceptPlayerId);
  const n = await q.bestRuns.countDocuments({
    $and: [except(skip), { $or: [above(score), same(score)] }],
  });
  return 1 + n;
}

/** The player's own rank, computed fresh (LB-08). Null without a best run or when hidden. */
export async function rankOfPlayer(q: Queryable, playerId: string): Promise<number | null> {
  const me = await q.bestRuns.findOne({ _id: playerId });
  if (!me) return null;
  const owner = await q.players.findOne({ _id: playerId }, { projection: { hidden: 1 } });
  if (!owner || owner.hidden) return null;
  const n = await q.bestRuns.countDocuments({
    $and: [
      except(await hiddenIds(q)),
      {
        $or: [
          above(me),
          { ...same(me), achievedAt: { $lt: me.achievedAt } },
          { ...same(me), achievedAt: me.achievedAt, _id: { $lt: playerId } },
        ],
      },
    ],
  });
  return 1 + n;
}

// ---------------------------------------------------------------------------------------------
// The public board (LB-04, LB-08)
// ---------------------------------------------------------------------------------------------

export const BOARD_DEFAULT_LIMIT = 10;
export const BOARD_MAX_LIMIT = 50;
/** The public top list may be this old (LB-08). */
export const BOARD_CACHE_MS = 30_000;

const toEntry = (
  rank: number,
  row: { nickname: string | null; points: number },
): LeaderboardEntry => ({
  rank,
  name: row.nickname ?? "—",
  points: row.points,
});

/** The top of the board in LB-01 order. Names only: no email ever leaves this file (LB-05). */
export async function topEntries(q: Queryable, limit: number): Promise<LeaderboardEntry[]> {
  const rows = await q.bestRuns
    .find(except(await hiddenIds(q)))
    // The player id makes the order total, so it matches rankOfPlayer exactly.
    .sort(RANK_ORDER)
    .limit(limit)
    .toArray();
  const owners = await q.players
    .find({ _id: { $in: rows.map((r) => r._id) } }, { projection: { nickname: 1 } })
    .toArray();
  const names = new Map(owners.map((p) => [p._id, p.nickname]));
  return rows.map((row, i) => toEntry(i + 1, { ...row, nickname: names.get(row._id) ?? null }));
}

/** The player's own row with a freshly computed rank (LB-08), or null when not on the board. */
export async function entryOfPlayer(
  q: Queryable,
  playerId: string,
): Promise<LeaderboardEntry | null> {
  const rank = await rankOfPlayer(q, playerId);
  if (rank === null) return null;
  const row = await q.bestRuns.findOne({ _id: playerId });
  if (!row) return null;
  const owner = await q.players.findOne({ _id: playerId }, { projection: { nickname: 1 } });
  return toEntry(rank, { ...row, nickname: owner?.nickname ?? null });
}

const topCache = new Map<number, { at: number; value: Promise<LeaderboardEntry[]> }>();

/**
 * topEntries through a per-instance cache of at most 30 s (LB-08), so a burst of players
 * opening the board costs one query per instance per half minute. A failed load isn't kept.
 */
export function cachedTop(q: Queryable, limit: number, now = Date.now()) {
  const hit = topCache.get(limit);
  if (hit && now - hit.at < BOARD_CACHE_MS) return hit.value;
  const value = topEntries(q, limit);
  topCache.set(limit, { at: now, value });
  value.catch(() => {
    if (topCache.get(limit)?.value === value) topCache.delete(limit);
  });
  return value;
}

export function clearBoardCache(): void {
  topCache.clear();
}
