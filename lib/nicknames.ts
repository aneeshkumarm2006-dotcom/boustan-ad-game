/**
 * Leaderboard names (LB-05). Players may pick a nickname; blank or rejected ones get a food
 * name such as "Falafel Rapide 27". Shared so the client can offer a reroll later.
 */
import { isValidNickname } from "@/lib/email";
import { isProfane } from "@/lib/profanity";

export const FOODS = [
  "Falafel",
  "Toum",
  "Pita",
  "Shawarma",
  "Navet",
  "Patate",
  "Sumac",
  "Taboulé",
  "Fattouche",
  "Hummus",
  "Za'atar",
  "Baklava",
  "Kafta",
  "Labneh",
];
export const MOODS = [
  "Rapide",
  "Turbo",
  "Pilote",
  "Express",
  "Ninja",
  "Pirate",
  "Sonic",
  "Flash",
  "Héros",
  "Zoom",
  "Bolide",
  "Fusée",
];

/** Longest food name the server gives a player saved without a usable name (LB-05). */
export const NICKNAME_MAX = 16;

export function autoNickname(random: () => number = Math.random): string {
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)];
  for (let i = 0; i < 12; i++) {
    const name = `${pick(FOODS)} ${pick(MOODS)} ${1 + Math.floor(random() * 99)}`;
    if (name.length <= NICKNAME_MAX) return name;
  }
  return `Toum Flash ${1 + Math.floor(random() * 99)}`;
}

export type NicknameProblem = "missing" | "format" | "rude";

/** Why a typed nickname can't be used, or null when it can (LB-05). The save form requires one. */
export function nicknameProblem(input: string): NicknameProblem | null {
  const value = input.normalize("NFC").trim().replace(/\s+/g, " ");
  if (value === "") return "missing";
  if (!isValidNickname(value)) return "format";
  return isProfane(value) ? "rude" : null;
}

/** The nickname to store, or null when it breaks the rules (the caller falls back to a food name). */
export function cleanNickname(input: string | null | undefined): string | null {
  if (!input) return null;
  const value = input.normalize("NFC").trim().replace(/\s+/g, " ");
  return isValidNickname(value) && !isProfane(value) ? value : null;
}
