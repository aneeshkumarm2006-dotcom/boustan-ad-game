import { describe, expect, it } from "vitest";
import { TUNING } from "./config";
import { distanceMAt } from "./curve";
import {
  POINTS_PER_GARLIC,
  POINTS_PER_METRE,
  WINNERS,
  compareScores,
  isBetterScore,
  isWinningRank,
  pointsOf,
  scoreOf,
} from "./score";

describe("pointsOf", () => {
  it("pays 1 point per metre and 10 per garlic", () => {
    expect(POINTS_PER_METRE).toBe(1);
    expect(POINTS_PER_GARLIC).toBe(10);
    expect(pointsOf({ distanceM: 0, garlic: 0 })).toBe(0);
    expect(pointsOf({ distanceM: 100, garlic: 0 })).toBe(100);
    expect(pointsOf({ distanceM: 0, garlic: 1 })).toBe(10);
    expect(pointsOf({ distanceM: 250, garlic: 14 })).toBe(390);
  });

  it("counts whole metres only", () => {
    expect(pointsOf({ distanceM: 99.99, garlic: 0 })).toBe(99);
    expect(pointsOf({ distanceM: 100.01, garlic: 2 })).toBe(120);
  });

  it("is an integer for any honest run", () => {
    for (const ms of [0, 1, 999, 20_700, 61_234, 600_000]) {
      const points = pointsOf({ distanceM: distanceMAt(ms), garlic: Math.floor(ms / 2500) });
      expect(Number.isInteger(points)).toBe(true);
    }
  });

  it("keeps the scoring rule in the tuning file", () => {
    expect(TUNING.scoring).toEqual({ pointsPerMetre: 1, pointsPerGarlic: 10 });
  });
});

describe("scoreOf", () => {
  it("carries the run's distance and garlic with its points", () => {
    expect(scoreOf({ distanceM: 42.5, garlic: 3 })).toEqual({
      points: 72,
      distanceM: 42.5,
      garlic: 3,
    });
  });
});

describe("compareScores", () => {
  const s = (points: number) => ({ points });

  it("ranks the most points first", () => {
    expect([s(10), s(300), s(0), s(75)].sort(compareScores)).toEqual([s(300), s(75), s(10), s(0)]);
  });

  it("calls equal points a tie, left to the caller's timestamps", () => {
    expect(compareScores(s(50), s(50))).toBe(0);
  });

  it("treats only a strictly better score as a new best", () => {
    expect(isBetterScore(s(1), null)).toBe(true);
    expect(isBetterScore(s(1), undefined)).toBe(true);
    expect(isBetterScore(s(40), s(40))).toBe(false);
    expect(isBetterScore(s(41), s(40))).toBe(true);
    expect(isBetterScore(s(39), s(40))).toBe(false);
  });
});

describe("winners", () => {
  it("are the top 3", () => {
    expect(WINNERS).toBe(3);
    expect([1, 2, 3].every(isWinningRank)).toBe(true);
    expect([0, 4, 10, -1, 1.5, NaN].some(isWinningRank)).toBe(false);
  });
});
