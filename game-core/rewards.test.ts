import { describe, expect, it } from "vitest";
import { compareScores, isBetterScore, isRewardId, unlockedRewards } from "./rewards";

describe("unlockedRewards (GAME-02)", () => {
  it("unlocks the Coke at 100 m and the garlic sauce at 10 garlic", () => {
    expect(unlockedRewards({ distanceM: 99.9, garlic: 9 })).toEqual([]);
    expect(unlockedRewards({ distanceM: 100, garlic: 0 })).toEqual(["free_coke"]);
    expect(unlockedRewards({ distanceM: 10, garlic: 10 })).toEqual(["free_garlic_sauce"]);
    expect(unlockedRewards({ distanceM: 250, garlic: 14 })).toEqual([
      "free_coke",
      "free_garlic_sauce",
    ]);
  });

  it("uses campaign thresholds when given", () => {
    const rules = { free_coke: { distanceM: 50 }, free_garlic_sauce: { garlic: 3 } };
    expect(unlockedRewards({ distanceM: 50, garlic: 3 }, rules)).toHaveLength(2);
  });

  it("recognizes reward ids", () => {
    expect(isRewardId("free_coke")).toBe(true);
    expect(isRewardId("free_pepsi")).toBe(false);
    expect(isRewardId(3)).toBe(false);
  });
});

describe("compareScores (LB-01)", () => {
  const s = (garlic: number, hits: number, distanceM: number) => ({ garlic, hits, distanceM });

  it("orders by garlic, then fewest hits, then distance", () => {
    const sorted = [s(5, 0, 300), s(9, 2, 100), s(9, 0, 50), s(9, 0, 80), s(12, 5, 20)].sort(
      compareScores,
    );
    expect(sorted).toEqual([s(12, 5, 20), s(9, 0, 80), s(9, 0, 50), s(9, 2, 100), s(5, 0, 300)]);
  });

  it("treats only a strictly better score as a new best", () => {
    expect(isBetterScore(s(1, 0, 10), null)).toBe(true);
    expect(isBetterScore(s(3, 1, 40), s(3, 1, 40))).toBe(false);
    expect(isBetterScore(s(3, 0, 40), s(3, 1, 400))).toBe(true);
  });
});
