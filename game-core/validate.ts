/**
 * Run validation (PRD SEC-02), shared by the server and the mock API. Pure: the caller checks
 * the token's signature and that it hasn't been used, then asks whether the numbers a client
 * reports could come from an honest run of that seed.
 *
 * Every check is an upper bound an honest client can't exceed, so real runs always pass:
 * distance comes from the same curve function the client uses, and a pickup or obstacle has to
 * spawn before the chicken can touch it.
 */
import { TUNING } from "./config";
import { distanceMAt } from "./curve";
import { createLevel, type Level } from "./level";
import type { Seed } from "./prng";

/** A run token is valid this long after it was issued (SEC-01). */
export const RUN_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
/** Reported distance may differ from the curve at `activeMs` by this fraction (SEC-02). */
export const DISTANCE_TOLERANCE = 0.02;
/** Server clocks can disagree by a little; the run-time check allows this much. */
export const CLOCK_SLACK_MS = 500;

export interface ReportedRun {
  /** Metres, unrounded. */
  distance: number;
  garlic: number;
  hits: number;
  activeMs: number;
}

export interface IssuedRun {
  seed: Seed;
  /** When the run token was issued (ms since epoch, server clock). */
  issuedAt: number;
  /** TUNING.version the token was issued under. */
  tuningVersion: number;
}

/** Why a run was flagged. Logged and stored, never shown to the player (SEC-03). */
export type RunFlag =
  "bad_input" | "version" | "expired" | "too_fast" | "distance" | "garlic" | "hits";

export type RunVerdict = { ok: true } | { ok: false; reason: RunFlag };

function isCount(n: number): boolean {
  return Number.isInteger(n) && n >= 0;
}

export function validateRun(
  issued: IssuedRun,
  run: ReportedRun,
  now: number,
  level: Level = createLevel(issued.seed),
): RunVerdict {
  const { distance, garlic, hits, activeMs } = run;
  if (!Number.isFinite(distance) || distance < 0 || !isCount(garlic) || !isCount(hits)) {
    return { ok: false, reason: "bad_input" };
  }
  if (!isCount(activeMs)) return { ok: false, reason: "bad_input" };
  // Another tuning builds other levels, so this run can't be checked against the current one.
  if (issued.tuningVersion !== TUNING.version) return { ok: false, reason: "version" };

  const elapsed = now - issued.issuedAt;
  if (elapsed > RUN_TOKEN_TTL_MS) return { ok: false, reason: "expired" };
  if (elapsed + CLOCK_SLACK_MS < activeMs) return { ok: false, reason: "too_fast" };

  const expected = distanceMAt(activeMs);
  if (Math.abs(distance - expected) > expected * DISTANCE_TOLERANCE + 1e-9) {
    return { ok: false, reason: "distance" };
  }
  if (garlic > level.garlicSpawnedUpTo(distance)) return { ok: false, reason: "garlic" };
  if (hits > level.obstaclesSpawnedUpTo(distance)) return { ok: false, reason: "hits" };
  return { ok: true };
}
