/**
 * Scoring and the leaderboard order, shared by the client, the mock API and the server.
 *
 * A run is worth one point per whole metre plus ten per garlic (TUNING.scoring). The top
 * `WINNERS` players on the leaderboard win; nothing else (distance, garlic count or hits on
 * their own) unlocks anything.
 */
import { TUNING } from "./config";

export const POINTS_PER_METRE: number = TUNING.scoring.pointsPerMetre;
export const POINTS_PER_GARLIC: number = TUNING.scoring.pointsPerGarlic;
/** How many players at the top of the leaderboard win. */
export const WINNERS: number = TUNING.winners;

export interface RunScore {
  /** What the leaderboard ranks by. */
  points: number;
  distanceM: number;
  garlic: number;
}

/** Points for a run: whole metres times the metre rate, plus the garlic bonus. */
export function pointsOf(run: { distanceM: number; garlic: number }): number {
  return Math.floor(run.distanceM) * POINTS_PER_METRE + run.garlic * POINTS_PER_GARLIC;
}

export function scoreOf(run: { distanceM: number; garlic: number }): RunScore {
  return { points: pointsOf(run), distanceM: run.distanceM, garlic: run.garlic };
}

/**
 * Leaderboard order: most points first. Negative when `a` ranks above `b`. Equal points go to
 * whoever got there first, which callers break with their own timestamps.
 */
export function compareScores(a: Pick<RunScore, "points">, b: Pick<RunScore, "points">): number {
  return b.points - a.points;
}

/** Whether `candidate` strictly beats `best` (or there is no best yet). */
export function isBetterScore(
  candidate: Pick<RunScore, "points">,
  best: Pick<RunScore, "points"> | null | undefined,
): boolean {
  return !best || compareScores(candidate, best) < 0;
}

/** Whether a leaderboard rank is a winning one. */
export function isWinningRank(rank: number): boolean {
  return Number.isInteger(rank) && rank >= 1 && rank <= WINNERS;
}
