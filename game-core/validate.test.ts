import { describe, expect, it } from "vitest";
import { TUNING } from "./config";
import { distanceMAt } from "./curve";
import recorded from "./fixtures/recorded-runs.json";
import { createLevel } from "./level";
import { RUN_TOKEN_TTL_MS, validateRun, type ReportedRun } from "./validate";

const runs = recorded.runs;
/** As if the token was issued at 0 and the run was posted right after it ended. */
const issued = (seed: number) => ({ seed, issuedAt: 0, tuningVersion: TUNING.version });
const at = (run: ReportedRun) => run.activeMs + 1500;

describe("validateRun accepts real runs (NFR-09)", () => {
  it("has recorded runs to check, with hits and garlic among them", () => {
    expect(runs.length).toBeGreaterThanOrEqual(12);
    expect(runs.some((r) => r.hits > 0)).toBe(true);
    expect(runs.some((r) => r.garlic >= 10 && r.distance >= 100)).toBe(true);
  });

  it.each(runs.map((r) => [r.scenario, r] as const))("accepts a recorded %s run", (_, run) => {
    expect(validateRun(issued(run.seed), run, at(run))).toEqual({ ok: true });
  });

  it("accepts a run posted up to two hours after its token", () => {
    const run = runs[0];
    expect(validateRun(issued(run.seed), run, RUN_TOKEN_TTL_MS).ok).toBe(true);
  });

  it("accepts a distance off the curve by up to 2%", () => {
    const run = runs.find((r) => r.distance > 50)!;
    const expected = distanceMAt(run.activeMs);
    const near = { ...run, distance: expected * 1.019, garlic: 0, hits: 0 };
    expect(validateRun(issued(run.seed), near, at(run)).ok).toBe(true);
  });
});

describe("validateRun rejects forged runs (AC-05)", () => {
  const run = runs.find((r) => r.distance > 100 && r.garlic > 0)!;
  const check = (patch: Partial<ReportedRun>, now = at(run)) =>
    validateRun(issued(run.seed), { ...run, ...patch }, now);

  it("a distance that doesn't match the time", () => {
    expect(check({ distance: distanceMAt(run.activeMs) * 1.03 })).toEqual({
      ok: false,
      reason: "distance",
    });
    expect(check({ distance: distanceMAt(run.activeMs) * 0.97 }).ok).toBe(false);
    expect(check({ activeMs: run.activeMs - 3000 }).ok).toBe(false);
  });

  it("more garlic than the seed spawned by that distance", () => {
    const spawned = createLevel(run.seed).garlicSpawnedUpTo(run.distance);
    expect(check({ garlic: spawned + 1 })).toEqual({ ok: false, reason: "garlic" });
    expect(check({ garlic: spawned }).ok).toBe(true);
  });

  it("more hits than obstacles spawned by that distance", () => {
    const spawned = createLevel(run.seed).obstaclesSpawnedUpTo(run.distance);
    expect(check({ hits: spawned + 1 })).toEqual({ ok: false, reason: "hits" });
  });

  it("a run longer than the time since its token was issued", () => {
    expect(check({}, run.activeMs - 2000)).toEqual({ ok: false, reason: "too_fast" });
  });

  it("an expired token", () => {
    expect(check({}, RUN_TOKEN_TTL_MS + 1)).toEqual({ ok: false, reason: "expired" });
  });

  it("a token issued under another tuning", () => {
    const old = { ...issued(run.seed), tuningVersion: TUNING.version - 1 };
    expect(validateRun(old, run, at(run))).toEqual({ ok: false, reason: "version" });
  });

  it("nonsense numbers", () => {
    for (const patch of [
      { garlic: -1 },
      { hits: 1.5 },
      { distance: Number.NaN },
      { distance: -3 },
      { activeMs: Number.POSITIVE_INFINITY },
    ]) {
      expect(check(patch)).toEqual({ ok: false, reason: "bad_input" });
    }
  });

  it("the same numbers on another seed, when that seed spawned less", () => {
    // Garlic counts differ by seed, so a replayed score can fail on a different seed.
    const greedy = { ...run, garlic: createLevel(run.seed).garlicSpawnedUpTo(run.distance) };
    const other = Array.from({ length: 50 }, (_, i) => i + 1).find(
      (seed) => createLevel(seed).garlicSpawnedUpTo(run.distance) < greedy.garlic,
    );
    expect(other).toBeDefined();
    expect(validateRun(issued(other!), greedy, at(run)).ok).toBe(false);
  });
});
