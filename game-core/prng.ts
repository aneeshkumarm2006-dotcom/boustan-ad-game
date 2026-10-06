/**
 * Seeded PRNG shared by the browser and the server (PRD GAME-06, NFR-09).
 *
 * Only 32-bit integer operations (Math.imul, shifts, xor) and one exact division are used, so
 * every JavaScript engine produces the same sequence for the same seed. Do not add Math.sin,
 * Math.exp, Math.pow or similar here: their last bits are not specified and differ by engine.
 */

export type Seed = number;

export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Float in [min, max). */
  range(min: number, max: number): number;
  /** Integer in [0, n). */
  int(n: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
}

/** Forces any number into an unsigned 32-bit seed. */
export function toSeed(value: number): Seed {
  return Number.isFinite(value) ? Math.trunc(value) >>> 0 : 0;
}

/** Derives an independent stream from a seed, so separate generators don't share draws. */
export function deriveSeed(seed: Seed, stream: number): Seed {
  // splitmix32-style finalizer over (seed, stream).
  let h = (toSeed(seed) ^ Math.imul(stream + 1, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** mulberry32: small, fast and good enough for level generation. */
export function createRng(seed: Seed): Rng {
  let state = toSeed(seed);
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (n) => Math.floor(next() * n),
    pick: (items) => items[Math.floor(next() * items.length)],
    chance: (p) => next() < p,
  };
}

/** A fresh random seed for offline runs, where the server can't issue one. */
export function randomSeed(): Seed {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0];
}
