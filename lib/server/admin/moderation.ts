/**
 * Moderation views (ADM-05, LB-07): the board as admins see it, with ids and emails and the
 * hidden entries, and the runs the validator flagged.
 */
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Queryable } from "@/db/client";
import { bestRuns, players, runs } from "@/db/schema";

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
  const rows = await q
    .select({
      playerId: players.id,
      nickname: players.nickname,
      email: players.email,
      hidden: players.hidden,
      garlic: bestRuns.garlic,
      hits: bestRuns.hits,
      distanceM: bestRuns.distanceM,
      achievedAt: bestRuns.achievedAt,
    })
    .from(bestRuns)
    .innerJoin(players, eq(players.id, bestRuns.playerId))
    .where(isNull(players.deletedAt))
    .orderBy(
      desc(bestRuns.garlic),
      asc(bestRuns.hits),
      desc(bestRuns.distanceM),
      asc(bestRuns.achievedAt),
      asc(bestRuns.playerId),
    )
    .limit(limit);
  let rank = 0;
  return rows.map((r) => ({ ...r, rank: r.hidden ? null : ++rank }));
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
  const rows = await q
    .select({
      id: runs.id,
      finishedAt: runs.finishedAt,
      reason: runs.flagReason,
      distanceM: runs.distanceM,
      garlic: runs.garlic,
      hits: runs.hits,
      activeMs: runs.activeMs,
      src: runs.src,
      hostOrigin: runs.hostOrigin,
      clientVersion: runs.clientVersion,
      playerId: runs.playerId,
    })
    .from(runs)
    .where(eq(runs.status, "flagged"))
    .orderBy(desc(runs.finishedAt))
    .limit(limit);
  return rows;
}

/** Flag counts by reason over the last 7 days, for the summary strip. */
export async function flagSummary(q: Queryable): Promise<{ reason: string; n: number }[]> {
  const rows = await q
    .select({ reason: runs.flagReason, n: sql<number>`count(*)::int` })
    .from(runs)
    .where(and(eq(runs.status, "flagged"), sql`${runs.finishedAt} > now() - interval '7 days'`))
    .groupBy(runs.flagReason)
    .orderBy(desc(sql`count(*)`));
  return rows.map((r) => ({ reason: r.reason ?? "unknown", n: r.n }));
}
