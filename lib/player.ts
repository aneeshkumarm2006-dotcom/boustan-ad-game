/**
 * What this device remembers about the player, all in localStorage (PRD EMB-07, DATA-01): the
 * player token from a saved score, so later runs are saved as they finish, and the local best.
 */
import { isBetterScore, type RunScore } from "@/game-core";
import { readJson, writeJson } from "@/lib/storage";

export interface SavedPlayer {
  token: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function isScore(v: unknown): v is RunScore {
  return (
    isObject(v) &&
    typeof v.points === "number" &&
    typeof v.distanceM === "number" &&
    typeof v.garlic === "number"
  );
}

function isPlayer(v: unknown): v is SavedPlayer {
  return isObject(v) && typeof v.token === "string";
}

export const loadPlayer = (): SavedPlayer | null => readJson("player", isPlayer);
export const savePlayer = (player: SavedPlayer | null): void => writeJson("player", player);

export const loadBest = (): RunScore | null => readJson("best", isScore);

/** Saves the score if it has more points than the local best. Returns true on a new best. */
export function recordLocalBest(score: RunScore): boolean {
  if (!isBetterScore(score, loadBest())) return false;
  writeJson("best", score);
  return true;
}
