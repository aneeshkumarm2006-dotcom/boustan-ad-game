/**
 * Every tuning value in one place (PRD GAME-01, GAME-07). Units are logical pixels and seconds
 * unless the name says otherwise. Playtests (GAME-08) adjust this file only.
 *
 * Changing anything under `speed`, `obstacles` or `garlic` changes the levels a seed builds, so
 * bump `version`: the server keeps validating runs started under the old version until their
 * tokens expire.
 */
export const TUNING = {
  version: 1,

  view: {
    /** Logical canvas width. Height depends on orientation. */
    width: 320,
    heightLandscape: 180,
    heightPortrait: 250,
    /** Viewport taller than width × this ratio uses the portrait height. */
    portraitRatio: 1.15,
    /** Distance from the bottom of the canvas to the ground line. */
    groundOffset: 30,
    chickX: 84,
    /** Screen x where new obstacles and garlic appear (just off the right edge). */
    spawnX: 328,
  },

  /** 1 m of distance is this many logical px. On the speed curve, 100 m takes about 20.7 s. */
  pxPerMetre: 40,

  physics: {
    gravity: 980,
    jump: -285,
    doubleJump: -255,
    /** A press this soon before landing jumps again on landing. */
    jumpBufferS: 0.12,
    /** Frame-time clamp: a slow frame never advances the game more than this. */
    maxFrameS: 1 / 30,
  },

  /** Speed is a pure function of active run time: min(max, start + accel × t). */
  speed: { start: 140, accel: 5.2, max: 330, title: 70 },

  heat: {
    /** Caught at this much heat. */
    max: 3,
    hit: 1,
    invulnerableS: 1.3,
    /** Each garlic pickup cools the spit by this much. */
    garlicCool: 0.4,
    /** Heat also creeps up by (creepBase + creepPerS × t) per second. */
    creepBase: 0.03,
    creepPerS: 0.0012,
  },

  obstacles: {
    /** Distance before the first obstacle. */
    firstAtPx: 220,
    /** Gap after each obstacle: m + rand × m × spread, where m = speed × speedFactor + base. */
    gapBase: 55,
    gapSpeedFactor: 0.62,
    gapSpread: 1.1,
    /** Base draw pool; repeats are weights. */
    pool: ["pickle", "pita", "sauce", "pickle", "pita"],
    /** Difficulty gates by distance (the reference's 8 s, 15 s and 22 s). */
    potatoFromM: 30,
    falafelFromM: 65,
    comboFromM: 110,
    potatoWeight: 2,
    falafelWeight: 2,
    comboWeight: 1,
    /** Extra room after a falafel or a combo. */
    falafelExtraGapPx: 70,
    comboExtraGapPx: 30,
    /** The combo's pita sits this far behind its pickle. */
    comboOffsetPx: 12,
    /** Movers travel faster than the street. */
    potatoExtraSpeed: 25,
    falafelExtraSpeed: 40,
    /** The garlic potato flies at this height above the ground and bobs by ±bob px. */
    potatoHeight: 19,
    potatoBob: 3,
    potatoBobRate: 6,
  },

  garlic: {
    /** Garlic is scheduled in run time, then placed at the distance of that moment. */
    firstAtS: 1.2,
    intervalMinS: 1.4,
    intervalMaxS: 3.2,
    /** Arcs of 3 or 5 start at this distance (the reference's 5 s). */
    arcFromM: 19,
    arcChance: 0.3,
    arcSpacingPx: 14,
    arcs: [
      [-16, -32, -16],
      [-12, -28, -36, -28, -12],
    ],
    /** Single heights above the ground; repeats are weights. */
    singleHeights: [-3, -3, -30, -60],
    /** Above a ground obstacle, a single floats at this height. */
    overObstacleHeight: -34,
    /** Obstacles closer than this (px) to a garlic spawn count as "near". */
    nearPx: 34,
  },

  /** Default unlock rules (PRD §5.1). The campaign config can override them. */
  rewards: {
    free_coke: { distanceM: 100 },
    free_garlic_sauce: { garlic: 10 },
  },

  /** Distance milestones (GAME-05): these, then every `milestoneEveryM` after the last. */
  milestonesM: [25, 50, 75, 100],
  milestoneEveryM: 100,
} as const;

export type Tuning = typeof TUNING;
export type BaseObstacleType = "pickle" | "pita" | "sauce" | "potato" | "falafel";
export type ObstacleDraw = BaseObstacleType | "combo";

/** Obstacle hitboxes in logical px (drawn from the bottom-left corner). */
export const OBSTACLE_SIZE: Record<BaseObstacleType, { w: number; h: number }> = {
  pickle: { w: 12, h: 17 },
  pita: { w: 20, h: 9 },
  sauce: { w: 7, h: 19 },
  falafel: { w: 10, h: 10 },
  potato: { w: 9, h: 8 },
};
