import { describe, expect, it } from "vitest";
import { createRng, deriveSeed, toSeed } from "./prng";

describe("createRng", () => {
  it("matches the frozen mulberry32 sequence", () => {
    // Frozen values: if these change, every seed builds a different level.
    const rng = createRng(12345);
    const draws = Array.from({ length: 5 }, () => rng.next());
    expect(draws).toEqual(GOLDEN_12345);
  });

  it("gives the same sequence for the same seed", () => {
    const a = createRng(987654321);
    const b = createRng(987654321);
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });

  it("stays in [0, 1) and covers the range", () => {
    const rng = createRng(7);
    let min = 1;
    let max = 0;
    for (let i = 0; i < 10_000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    expect(min).toBeLessThan(0.01);
    expect(max).toBeGreaterThan(0.99);
  });

  it("has range, int, pick and chance helpers in bounds", () => {
    const rng = createRng(42);
    for (let i = 0; i < 1000; i++) {
      const r = rng.range(1.4, 3.2);
      expect(r).toBeGreaterThanOrEqual(1.4);
      expect(r).toBeLessThan(3.2);
      const n = rng.int(5);
      expect(Number.isInteger(n) && n >= 0 && n < 5).toBe(true);
      expect(["a", "b", "c"]).toContain(rng.pick(["a", "b", "c"]));
      expect(typeof rng.chance(0.3)).toBe("boolean");
    }
  });
});

describe("seeds", () => {
  it("coerces any number to an unsigned 32-bit integer", () => {
    expect(toSeed(-1)).toBe(4294967295);
    expect(toSeed(2 ** 32 + 5)).toBe(5);
    expect(toSeed(3.9)).toBe(3);
    expect(toSeed(Number.NaN)).toBe(0);
  });

  it("derives different, stable streams", () => {
    expect(deriveSeed(1, 1)).toBe(deriveSeed(1, 1));
    expect(deriveSeed(1, 1)).not.toBe(deriveSeed(1, 2));
    expect(deriveSeed(1, 1)).not.toBe(deriveSeed(2, 1));
  });
});

const GOLDEN_12345 = [
  0.9797282677609473, 0.3067522644996643, 0.484205421525985, 0.817934412509203, 0.5094283693470061,
];
