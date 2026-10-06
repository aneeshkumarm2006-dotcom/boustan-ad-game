/**
 * Level generator (PRD GAME-06, GAME-07). Everything that affects play comes from the seed:
 * obstacle types, the gaps between them, potato bob phases, and garlic placement. The server
 * runs the same code to bound a run's garlic and hits (SEC-02).
 *
 * Spawns are placed in run distance, not screen space: a spawn with `at = d` appears at
 * TUNING.view.spawnX when the run has covered d px. Runs are endless, so the level is built
 * lazily with `extendTo`. Obstacles and garlic draw from separate streams, so the result
 * doesn't depend on how the calls are chunked.
 */
import { OBSTACLE_SIZE, TUNING, type BaseObstacleType, type ObstacleDraw } from "./config";
import { distancePxAt, metresToPx, pxToMetres, speedAtDistancePx, timeAtDistancePx } from "./curve";
import { createRng, deriveSeed, toSeed, type Rng, type Seed } from "./prng";

export interface ObstacleSpawn {
  type: BaseObstacleType;
  /** Run distance (px) at which it appears at spawnX. */
  at: number;
  /** Extra speed (px/s) on top of the street, for movers. */
  extra: number;
  /** Bob phase in radians (potatoes only; 0 otherwise). */
  phase: number;
  w: number;
  h: number;
}

export interface GarlicSpawn {
  /** Run distance (px) at which it appears at spawnX. */
  at: number;
  /** Height relative to the ground line (negative is up). */
  dy: number;
}

export interface Level {
  readonly seed: Seed;
  /** Sorted by `at`. Grows as `extendTo` is called. */
  readonly obstacles: readonly ObstacleSpawn[];
  /** Sorted by `at`. Grows as `extendTo` is called. */
  readonly garlic: readonly GarlicSpawn[];
  /** Builds spawns up to at least `px` of run distance. */
  extendTo(px: number): void;
  /** Obstacles that have appeared by `distanceM` (a combo counts as two). */
  obstaclesSpawnedUpTo(distanceM: number): number;
  /** Garlic pickups that have appeared by `distanceM`. */
  garlicSpawnedUpTo(distanceM: number): number;
}

const OBSTACLE_STREAM = 1;
const GARLIC_STREAM = 2;
/** Garlic placement looks at obstacles up to this far ahead, so build them first. */
const OBSTACLE_LOOKAHEAD_PX = 400;

/** Number of items with `at <= px` in a list sorted by `at`. */
function countUpTo(items: readonly { at: number }[], px: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (items[mid].at <= px) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function obstacle(type: BaseObstacleType, at: number, rng: Rng): ObstacleSpawn {
  const cfg = TUNING.obstacles;
  const extra =
    type === "potato" ? cfg.potatoExtraSpeed : type === "falafel" ? cfg.falafelExtraSpeed : 0;
  const phase = type === "potato" ? rng.range(0, 6) : 0;
  return { type, at, extra, phase, ...OBSTACLE_SIZE[type] };
}

function drawPool(distanceM: number): ObstacleDraw[] {
  const cfg = TUNING.obstacles;
  const pool: ObstacleDraw[] = [...cfg.pool];
  if (distanceM >= cfg.potatoFromM) for (let i = 0; i < cfg.potatoWeight; i++) pool.push("potato");
  if (distanceM >= cfg.falafelFromM)
    for (let i = 0; i < cfg.falafelWeight; i++) pool.push("falafel");
  if (distanceM >= cfg.comboFromM) for (let i = 0; i < cfg.comboWeight; i++) pool.push("combo");
  return pool;
}

export function createLevel(seed: Seed): Level {
  const s = toSeed(seed);
  const obstacleRng = createRng(deriveSeed(s, OBSTACLE_STREAM));
  const garlicRng = createRng(deriveSeed(s, GARLIC_STREAM));
  const obstacles: ObstacleSpawn[] = [];
  const garlic: GarlicSpawn[] = [];
  const { obstacles: ob, garlic: ga, view } = TUNING;

  let nextObstacleAt: number = ob.firstAtPx;
  let nextGarlicT: number = ga.firstAtS;

  function extendObstacles(px: number): void {
    while (nextObstacleAt <= px) {
      const at = nextObstacleAt;
      const draw = obstacleRng.pick(drawPool(pxToMetres(at)));
      let extraGap = 0;
      if (draw === "combo") {
        obstacles.push(obstacle("pickle", at, obstacleRng));
        obstacles.push(obstacle("pita", at + ob.comboOffsetPx, obstacleRng));
        extraGap = ob.comboExtraGapPx;
      } else {
        obstacles.push(obstacle(draw, at, obstacleRng));
        if (draw === "falafel") extraGap = ob.falafelExtraGapPx;
      }
      const m = speedAtDistancePx(at) * ob.gapSpeedFactor + ob.gapBase;
      nextObstacleAt = at + m + obstacleRng.next() * m * ob.gapSpread + extraGap;
    }
  }

  /** Obstacles close to spawnX at the moment garlic spawns at run distance `at`. */
  function nearby(at: number): { ground: boolean; air: boolean } {
    const t = timeAtDistancePx(at);
    let ground = false;
    let air = false;
    for (let i = obstacles.length - 1; i >= 0; i--) {
      const o = obstacles[i];
      if (o.at < at - view.spawnX) break; // long gone
      // Already on screen: where it is now. Not yet spawned: how far behind spawnX it will be.
      const gap = o.at <= at ? at - o.at + o.extra * (t - timeAtDistancePx(o.at)) : o.at - at;
      if (gap < ga.nearPx) {
        if (o.type === "potato") air = true;
        else ground = true;
      }
    }
    return { ground, air };
  }

  function extendGarlic(px: number): void {
    while (distancePxAt(nextGarlicT) <= px) {
      const at = distancePxAt(nextGarlicT);
      extendObstacles(at + OBSTACLE_LOOKAHEAD_PX);
      const near = nearby(at);
      if (pxToMetres(at) >= ga.arcFromM && garlicRng.chance(ga.arcChance) && !near.air) {
        const arc = garlicRng.pick(ga.arcs);
        arc.forEach((dy, i) => garlic.push({ at: at + i * ga.arcSpacingPx, dy }));
      } else {
        let dy: number = near.ground ? ga.overObstacleHeight : garlicRng.pick(ga.singleHeights);
        if (near.air && dy === -30) dy = -3;
        garlic.push({ at, dy });
      }
      nextGarlicT += garlicRng.range(ga.intervalMinS, ga.intervalMaxS);
    }
  }

  function extendTo(px: number): void {
    extendObstacles(px + OBSTACLE_LOOKAHEAD_PX);
    extendGarlic(px);
  }

  return {
    seed: s,
    obstacles,
    garlic,
    extendTo,
    obstaclesSpawnedUpTo(distanceM) {
      const px = metresToPx(distanceM);
      extendTo(px);
      return countUpTo(obstacles, px);
    },
    garlicSpawnedUpTo(distanceM) {
      const px = metresToPx(distanceM);
      extendTo(px);
      return countUpTo(garlic, px);
    },
  };
}

/**
 * A short fingerprint of everything a seed spawns up to `distanceM`. Two environments that
 * print the same digest built the same level (NFR-09).
 */
export function levelDigest(seed: Seed, distanceM: number): string {
  const level = createLevel(seed);
  const px = metresToPx(distanceM);
  level.extendTo(px);
  const parts: string[] = [];
  for (const o of level.obstacles) if (o.at <= px) parts.push(`${o.type}@${o.at}~${o.phase}`);
  for (const g of level.garlic) if (g.at <= px) parts.push(`g@${g.at}:${g.dy}`);
  // FNV-1a, 32-bit.
  let h = 0x811c9dc5;
  const text = parts.join("|");
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${parts.length}:${(h >>> 0).toString(16).padStart(8, "0")}`;
}
