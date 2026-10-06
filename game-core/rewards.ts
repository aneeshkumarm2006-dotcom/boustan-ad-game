/**
 * Reward rules (PRD §5.1, GAME-02) and the leaderboard order (LB-01), shared by the client,
 * the mock API and the server.
 */
import { TUNING } from "./config";

export const REWARD_IDS = ["free_coke", "free_garlic_sauce"] as const;
export type RewardId = (typeof REWARD_IDS)[number];

export interface RewardRules {
  free_coke: { distanceM: number };
  free_garlic_sauce: { garlic: number };
}

export const DEFAULT_REWARD_RULES: RewardRules = {
  free_coke: { distanceM: TUNING.rewards.free_coke.distanceM },
  free_garlic_sauce: { garlic: TUNING.rewards.free_garlic_sauce.garlic },
};

export interface RunScore {
  distanceM: number;
  garlic: number;
  hits: number;
}

export function isRewardId(value: unknown): value is RewardId {
  return typeof value === "string" && (REWARD_IDS as readonly string[]).includes(value);
}

/** Whether a score meets one reward's rule. */
export function meetsRule(
  id: RewardId,
  score: Pick<RunScore, "distanceM" | "garlic">,
  rules: RewardRules = DEFAULT_REWARD_RULES,
): boolean {
  return id === "free_coke"
    ? score.distanceM >= rules.free_coke.distanceM
    : score.garlic >= rules.free_garlic_sauce.garlic;
}

/** Rewards a score unlocks, in catalogue order. */
export function unlockedRewards(
  score: Pick<RunScore, "distanceM" | "garlic">,
  rules: RewardRules = DEFAULT_REWARD_RULES,
): RewardId[] {
  return REWARD_IDS.filter((id) => meetsRule(id, score, rules));
}

/**
 * Leaderboard order (LB-01): most garlic, then fewest hits, then longest distance. Negative
 * when `a` ranks above `b`. Ties on all three go to whoever got there first, which callers
 * break with their own timestamps.
 */
export function compareScores(a: RunScore, b: RunScore): number {
  if (a.garlic !== b.garlic) return b.garlic - a.garlic;
  if (a.hits !== b.hits) return a.hits - b.hits;
  return b.distanceM - a.distanceM;
}

/** Whether `candidate` beats `best` (or there is no best yet). */
export function isBetterScore(candidate: RunScore, best: RunScore | null | undefined): boolean {
  return !best || compareScores(candidate, best) < 0;
}
