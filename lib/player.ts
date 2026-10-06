/**
 * What this device remembers about the player, all in localStorage (PRD EMB-07, DATA-01):
 * the player token from a claim, the local best, codes for "My rewards", and a pending claim
 * that survives a reload for 30 minutes (§3.4).
 */
import { isBetterScore, isRewardId, type RewardId, type RunScore } from "@/game-core";
import type { IssuedCode } from "@/lib/api";
import { readJson, writeJson } from "@/lib/storage";

export interface SavedPlayer {
  token: string;
  /** "a•••@gmail.com", for one-tap claims. The full address is never stored. */
  emailMasked: string;
}

export interface PendingClaim {
  runId: string;
  claimToken: string;
  unlocked: RewardId[];
  score: RunScore;
  expiresAt: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function isScore(v: unknown): v is RunScore {
  return (
    isObject(v) &&
    typeof v.distanceM === "number" &&
    typeof v.garlic === "number" &&
    typeof v.hits === "number"
  );
}

function isPlayer(v: unknown): v is SavedPlayer {
  return isObject(v) && typeof v.token === "string" && typeof v.emailMasked === "string";
}

function isCodes(v: unknown): v is IssuedCode[] {
  return (
    Array.isArray(v) &&
    v.every(
      (c) =>
        isObject(c) &&
        isRewardId(c.reward) &&
        typeof c.code === "string" &&
        typeof c.expiresAt === "string",
    )
  );
}

function isPending(v: unknown): v is PendingClaim {
  return (
    isObject(v) &&
    typeof v.runId === "string" &&
    typeof v.claimToken === "string" &&
    Array.isArray(v.unlocked) &&
    v.unlocked.every(isRewardId) &&
    isScore(v.score) &&
    typeof v.expiresAt === "number"
  );
}

export const loadPlayer = (): SavedPlayer | null => readJson("player", isPlayer);
export const savePlayer = (player: SavedPlayer | null): void => writeJson("player", player);

export const loadBest = (): RunScore | null => readJson("best", isScore);

/** Saves the score if it beats the local best (LB-01 order). Returns true on a new best. */
export function recordLocalBest(score: RunScore): boolean {
  if (!isBetterScore(score, loadBest())) return false;
  writeJson("best", score);
  return true;
}

export const loadCodes = (): IssuedCode[] => readJson("codes", isCodes) ?? [];

/** Adds codes to "My rewards", newest first, without duplicates. */
export function addCodes(codes: readonly IssuedCode[]): void {
  const seen = new Set(codes.map((c) => c.code));
  writeJson("codes", [...codes, ...loadCodes().filter((c) => !seen.has(c.code))]);
}

export function loadPending(now = Date.now()): PendingClaim | null {
  const pending = readJson("pending", isPending);
  if (pending && pending.expiresAt > now) return pending;
  if (pending) writeJson("pending", null);
  return null;
}

export const savePending = (pending: PendingClaim | null): void => writeJson("pending", pending);
