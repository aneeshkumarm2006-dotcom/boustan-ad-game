import { describe, expect, it } from "vitest";
import { TUNING } from "./config";
import { metresToPx, pxToMetres } from "./curve";
import golden from "./golden-digests.json";
import { createLevel, levelDigest } from "./level";

describe("createLevel", () => {
  it("builds the frozen level for each golden seed", () => {
    for (const [seed, digest] of Object.entries(golden.digests)) {
      expect(levelDigest(Number(seed), golden.distanceM)).toBe(digest);
    }
  });

  it("builds the same level however extendTo is chunked", () => {
    const whole = createLevel(99);
    whole.extendTo(metresToPx(600));
    const chunked = createLevel(99);
    for (let m = 0; m <= 600; m += 7) chunked.extendTo(metresToPx(m));
    const cut = (items: readonly { at: number }[]) => items.filter((i) => i.at <= metresToPx(600));
    expect(cut(chunked.obstacles)).toEqual(cut(whole.obstacles));
    expect(cut(chunked.garlic)).toEqual(cut(whole.garlic));
  });

  it("builds different levels for different seeds", () => {
    expect(levelDigest(1, 300)).not.toBe(levelDigest(2, 300));
  });

  it("keeps spawns sorted by distance", () => {
    const level = createLevel(5);
    level.extendTo(metresToPx(1000));
    for (const list of [level.obstacles, level.garlic]) {
      for (let i = 1; i < list.length; i++)
        expect(list[i].at).toBeGreaterThanOrEqual(list[i - 1].at);
    }
  });

  it("gates obstacle types by distance (GAME-07)", () => {
    const { potatoFromM, falafelFromM, comboFromM, comboOffsetPx } = TUNING.obstacles;
    let combos = 0;
    for (let seed = 0; seed < 50; seed++) {
      const level = createLevel(seed);
      level.extendTo(metresToPx(400));
      level.obstacles.forEach((o, i) => {
        const m = pxToMetres(o.at);
        if (o.type === "potato") expect(m).toBeGreaterThanOrEqual(potatoFromM);
        if (o.type === "falafel") expect(m).toBeGreaterThanOrEqual(falafelFromM);
        const next = level.obstacles[i + 1];
        if (o.type === "pickle" && next?.type === "pita" && next.at - o.at === comboOffsetPx) {
          combos++;
          expect(m).toBeGreaterThanOrEqual(comboFromM);
        }
      });
    }
    expect(combos).toBeGreaterThan(0);
  });

  it("keeps obstacles far enough apart to jump between", () => {
    const level = createLevel(3);
    level.extendTo(metresToPx(800));
    const singles = level.obstacles.filter(
      (o, i, all) => !(o.type === "pita" && all[i - 1] && o.at - all[i - 1].at === 12),
    );
    for (let i = 1; i < singles.length; i++) {
      expect(singles[i].at - singles[i - 1].at).toBeGreaterThan(TUNING.obstacles.gapBase);
    }
  });

  it("places garlic singles at the reference heights and arcs of 3 or 5", () => {
    const level = createLevel(11);
    level.extendTo(metresToPx(1000));
    const heights = new Set(level.garlic.map((g) => g.dy));
    for (const dy of heights) {
      expect([-3, -30, -60, -34, -16, -32, -12, -28, -36]).toContain(dy);
    }
    const firstArc = level.garlic.findIndex((g) => g.dy === -16 || g.dy === -12);
    expect(firstArc).toBeGreaterThan(-1);
    expect(pxToMetres(level.garlic[firstArc].at)).toBeGreaterThanOrEqual(TUNING.garlic.arcFromM);
  });
});

describe("validator queries", () => {
  it("count spawns up to a distance, growing with distance", () => {
    const level = createLevel(1);
    expect(level.obstaclesSpawnedUpTo(0)).toBe(0);
    expect(level.garlicSpawnedUpTo(0)).toBe(0);
    let lastO = 0;
    let lastG = 0;
    for (let m = 10; m <= 500; m += 10) {
      const o = level.obstaclesSpawnedUpTo(m);
      const g = level.garlicSpawnedUpTo(m);
      expect(o).toBeGreaterThanOrEqual(lastO);
      expect(g).toBeGreaterThanOrEqual(lastG);
      lastO = o;
      lastG = g;
    }
    expect(lastO).toBeGreaterThan(30);
    expect(lastG).toBeGreaterThan(30);
  });

  it("agree with the spawn lists and don't depend on query order", () => {
    const a = createLevel(77);
    const b = createLevel(77);
    const late = a.garlicSpawnedUpTo(300);
    const early = a.garlicSpawnedUpTo(100);
    expect(b.garlicSpawnedUpTo(100)).toBe(early);
    expect(b.garlicSpawnedUpTo(300)).toBe(late);
    expect(a.garlic.filter((g) => g.at <= metresToPx(100)).length).toBe(early);
    expect(a.obstaclesSpawnedUpTo(250)).toBe(
      a.obstacles.filter((o) => o.at <= metresToPx(250)).length,
    );
  });

  it("spawns enough garlic to make 10 reachable in a typical run", () => {
    // Players who reach ~140 m should have seen at least 10 pickups on every seed.
    for (let seed = 0; seed < 200; seed++) {
      expect(createLevel(seed).garlicSpawnedUpTo(140)).toBeGreaterThanOrEqual(10);
    }
  });
});
