/**
 * Best runs and ranks (LB-01 to LB-03). Order: most garlic, fewest hits, longest distance, then
 * whoever got there first. Only players with an email have a row, and hidden or deleted
 * players don't count.
 */
import { and, asc, desc, eq, isNull, ne, sql, type SQL } from "drizzle-orm";
import type { Queryable } from "@/db/client";
import { bestRuns, players } from "@/db/schema";
import type { RunScore } from "@/game-core";
import type { LeaderboardEntry } from "@/lib/api/types";

/** best_runs rows that rank strictly above `s`, before tie-breaks. */
function above(s: RunScore): SQL {
  return sql`(${bestRuns.garlic} > ${s.garlic}
    or (${bestRuns.garlic} = ${s.garlic} and (${bestRuns.hits} < ${s.hits}
    or (${bestRuns.hits} = ${s.hits} and ${bestRuns.distanceM} > ${s.distanceM}))))`;
}

function same(s: RunScore): SQL {
  return sql`(${bestRuns.garlic} = ${s.garlic} and ${bestRuns.hits} = ${s.hits}
    and ${bestRuns.distanceM} = ${s.distanceM})`;
}

const visible = and(eq(players.hidden, false), isNull(players.deletedAt));

/** Keeps the player's best validated run (LB-02). Only a strictly better run replaces it. */
export async function updateBestRun(
  q: Queryable,
  playerId: string,
  run: RunScore & { runId: string; at: Date },
): Promise<void> {
  await q
    .insert(bestRuns)
    .values({
      playerId,
      runId: run.runId,
      garlic: run.garlic,
      hits: run.hits,
      distanceM: run.distanceM,
      achievedAt: run.at,
    })
    .onConflictDoUpdate({
      target: bestRuns.playerId,
      set: {
        runId: sql`excluded.run_id`,
        garlic: sql`excluded.garlic`,
        hits: sql`excluded.hits`,
        distanceM: sql`excluded.distance_m`,
        achievedAt: sql`excluded.achieved_at`,
      },
      setWhere: sql`excluded.garlic > ${bestRuns.garlic}
        or (excluded.garlic = ${bestRuns.garlic} and (excluded.hits < ${bestRuns.hits}
        or (excluded.hits = ${bestRuns.hits} and excluded.distance_m > ${bestRuns.distanceM})))`,
    });
}

export async function bestOf(q: Queryable, playerId: string): Promise<RunScore | null> {
  const [row] = await q
    .select({ garlic: bestRuns.garlic, hits: bestRuns.hits, distanceM: bestRuns.distanceM })
    .from(bestRuns)
    .where(eq(bestRuns.playerId, playerId));
  return row ?? null;
}

/**
 * The rank a new score would get now (results preview). Equal scores already on the board got
 * there first, so they stay ahead.
 */
export async function rankPreview(
  q: Queryable,
  score: RunScore,
  exceptPlayerId: string | null,
): Promise<number> {
  const [row] = await q
    .select({ n: sql<number>`count(*)::int` })
    .from(bestRuns)
    .innerJoin(players, eq(players.id, bestRuns.playerId))
    .where(
      and(
        visible,
        sql`(${above(score)} or ${same(score)})`,
        exceptPlayerId ? ne(bestRuns.playerId, exceptPlayerId) : undefined,
      ),
    );
  return 1 + (row?.n ?? 0);
}

/** The player's own rank, computed fresh (LB-08). Null without a best run or when hidden. */
export async function rankOfPlayer(q: Queryable, playerId: string): Promise<number | null> {
  const [me] = await q
    .select({
      garlic: bestRuns.garlic,
      hits: bestRuns.hits,
      distanceM: bestRuns.distanceM,
      at: bestRuns.achievedAt,
      hidden: players.hidden,
    })
    .from(bestRuns)
    .innerJoin(players, eq(players.id, bestRuns.playerId))
    .where(eq(bestRuns.playerId, playerId));
  if (!me || me.hidden) return null;
  // Raw SQL skips Drizzle's column mapping, and its postgres.js driver takes dates as strings.
  const at = me.at.toISOString();
  const [row] = await q
    .select({ n: sql<number>`count(*)::int` })
    .from(bestRuns)
    .innerJoin(players, eq(players.id, bestRuns.playerId))
    .where(
      and(
        visible,
        ne(bestRuns.playerId, playerId),
        sql`(${above(me)} or (${same(me)} and (${bestRuns.achievedAt} < ${at}
          or (${bestRuns.achievedAt} = ${at} and ${bestRuns.playerId} < ${playerId}))))`,
      ),
    );
  return 1 + (row?.n ?? 0);
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
  row: { nickname: string | null; garlic: number; hits: number; distanceM: number },
): LeaderboardEntry => ({
  rank,
  name: row.nickname ?? "—",
  garlic: row.garlic,
  hits: row.hits,
  // The game shows whole metres.
  distanceM: Math.floor(row.distanceM),
});

/** The top of the board in LB-01 order. Names only: no email ever leaves this file (LB-05). */
export async function topEntries(q: Queryable, limit: number): Promise<LeaderboardEntry[]> {
  const rows = await q
    .select({
      nickname: players.nickname,
      garlic: bestRuns.garlic,
      hits: bestRuns.hits,
      distanceM: bestRuns.distanceM,
    })
    .from(bestRuns)
    .innerJoin(players, eq(players.id, bestRuns.playerId))
    .where(visible)
    // The player id makes the order total, so it matches rankOfPlayer exactly.
    .orderBy(
      desc(bestRuns.garlic),
      asc(bestRuns.hits),
      desc(bestRuns.distanceM),
      asc(bestRuns.achievedAt),
      asc(bestRuns.playerId),
    )
    .limit(limit);
  return rows.map((row, i) => toEntry(i + 1, row));
}

/** The player's own row with a freshly computed rank (LB-08), or null when not on the board. */
export async function entryOfPlayer(
  q: Queryable,
  playerId: string,
): Promise<LeaderboardEntry | null> {
  const rank = await rankOfPlayer(q, playerId);
  if (rank === null) return null;
  const [row] = await q
    .select({
      nickname: players.nickname,
      garlic: bestRuns.garlic,
      hits: bestRuns.hits,
      distanceM: bestRuns.distanceM,
    })
    .from(bestRuns)
    .innerJoin(players, eq(players.id, bestRuns.playerId))
    .where(eq(bestRuns.playerId, playerId));
  return row ? toEntry(rank, row) : null;
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
