import { describe, expect, it } from "vitest";
import { TUNING } from "./config";
import { distanceMAt, distancePxAt, speedAt, speedAtDistancePx, timeAtDistancePx } from "./curve";

describe("speed curve", () => {
  it("matches the reference: 140 px/s, +5.2 px/s each second, capped at 330", () => {
    expect(speedAt(0)).toBe(140);
    expect(speedAt(10)).toBeCloseTo(192);
    expect(speedAt(36)).toBeCloseTo(327.2);
    expect(speedAt(60)).toBe(330);
  });

  it("reaches 100 m after about 21 s alive (GAME-01)", () => {
    const t = timeAtDistancePx(100 * TUNING.pxPerMetre);
    expect(t).toBeGreaterThan(20);
    expect(t).toBeLessThan(21.5);
    expect(distanceMAt(t * 1000)).toBeCloseTo(100, 6);
  });

  it("is the integral of speed, continuous across the cap", () => {
    for (let t = 0.5; t < 80; t += 0.5) {
      const dt = 1e-4;
      const slope = (distancePxAt(t + dt) - distancePxAt(t - dt)) / (2 * dt);
      expect(slope).toBeCloseTo(speedAt(t), 2);
    }
  });

  it("inverts exactly enough for validation", () => {
    for (const d of [0, 1, 220, 1286, 4000, 8000, 30_000]) {
      expect(distancePxAt(timeAtDistancePx(d))).toBeCloseTo(d, 6);
      expect(speedAtDistancePx(d)).toBeCloseTo(speedAt(timeAtDistancePx(d)), 6);
    }
  });

  it("clamps negative input", () => {
    expect(distancePxAt(-1)).toBe(0);
    expect(timeAtDistancePx(-5)).toBe(0);
    expect(speedAtDistancePx(-5)).toBe(140);
  });

  it("converts the reference's time gates to the distance gates in the config", () => {
    const m = (s: number) => distanceMAt(s * 1000);
    expect(m(8)).toBeCloseTo(TUNING.obstacles.potatoFromM, -1);
    expect(m(15)).toBeCloseTo(TUNING.obstacles.falafelFromM, -1);
    expect(m(22)).toBeCloseTo(TUNING.obstacles.comboFromM, -1);
    expect(m(5)).toBeCloseTo(TUNING.garlic.arcFromM, 0);
  });
});
