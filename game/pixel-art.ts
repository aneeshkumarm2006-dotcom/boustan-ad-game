/**
 * Pixel art as row strings plus a palette, from the reference prototype. Pure data, so React
 * icons (PixelIcon) and the canvas sprites draw from the same source. Every colour is a Boustan
 * palette colour or a mix() of two of them (guide de style: no other colours).
 */
import { PALETTE as P, mix } from "@/lib/brand";

export interface PixelArt {
  rows: readonly string[];
  palette: Readonly<Record<string, string>>;
}

const CHICKEN: Record<string, string> = {
  W: P.toum,
  w: mix(P.toum, P.vert, 0.12),
  S: mix(P.toum, P.vert, 0.25),
  R: P.tomate,
  Y: P.poivron,
  O: P.poivron,
  K: P.vert,
};

const HEAD = [
  "..........RR....",
  ".........RRRR...",
  ".........WWWW...",
  "........WWWKWW..",
  "........WWWWWYYY",
  "........WWWWRY..",
];

export const ART = {
  run1: {
    rows: HEAD.concat([
      "WW......WWWW....",
      "WWW....WWWWW....",
      ".WWWWWWWWWWW....",
      ".WWWwwwwWWWW....",
      ".WWWWwwwWWWW....",
      "..WWWWWWWWWW....",
      "...SWWWWWWS.....",
      ".....O...O......",
      "....O.....O.....",
      "...OO.....OO....",
    ]),
    palette: CHICKEN,
  },
  run2: {
    rows: HEAD.concat([
      "WW......WWWW....",
      "WWW....WWWWW....",
      ".WWWWWWWWWWW....",
      ".WWWWWWwwwWW....",
      ".WWWWWWwwWWW....",
      "..WWWWWWWWWW....",
      "...SWWWWWWS.....",
      "......OO........",
      "......O.O.......",
      ".....OO.OO......",
    ]),
    palette: CHICKEN,
  },
  jump: {
    rows: HEAD.concat([
      "WW...wwwWWWW....",
      "WWW..wwWWWWW....",
      ".WWWWWWWWWWW....",
      ".WWWWWWWWWWW....",
      ".WWWWWWWWWWW....",
      "..WWWWWWWWWW....",
      "...SWWWWWWS.....",
      "....OO..OO......",
      "................",
      "................",
    ]),
    palette: CHICKEN,
  },
  /** Shawarma wrap: the chicken's last stand when the spit catches it. */
  wrap: {
    rows: [
      "....TTTTTT....",
      "..TTttttttTT..",
      ".TtCCCCCCCCtT.",
      "TtCgCCrCCgCCtT",
      "TtCCCCCCCCCCtT",
      "PPPPPPPPPPPPPP",
      "PPPPPPPPPPPPPP",
      ".PPPPPPPPPPPP.",
      "..PPPPPPPPPP..",
    ],
    palette: {
      T: P.hummus,
      t: mix(P.hummus, P.toum, 0.5),
      C: mix(P.poivron, P.vert, 0.5),
      g: P.laitue,
      r: P.navet,
      P: P.toum,
    },
  },
  falafel: {
    rows: [
      "...FFFF...",
      ".FFffFFFF.",
      ".FfFFFFdF.",
      "FFFFFdFFFF",
      "FFdFFFFFFF",
      "FFFFFFFdFF",
      "FFFFdFFFFF",
      ".FFFFFFFF.",
      ".FFdFFFFF.",
      "...FFFF...",
    ],
    palette: {
      F: mix(P.poivron, P.vert, 0.4),
      f: P.hummus,
      d: mix(P.poivron, P.vert, 0.7),
    },
  },
  /**
   * Flying garlic potato, an obstacle. GAME-11: it must not read as a pickup, so it is hummus
   * with a Vert outline and an angry face, trails a Tomate streak and never glows.
   */
  potato: {
    rows: [
      "..ooooo..",
      ".oGgggGo.",
      "oGkGGGkGo",
      "oGekGkeGo",
      "oGGGGGGGo",
      "oGhGGGhGo",
      ".oGGhGGo.",
      "..ooooo..",
    ],
    palette: {
      o: P.vert,
      G: P.hummus,
      g: mix(P.hummus, P.toum, 0.55),
      h: mix(P.hummus, P.vert, 0.3),
      e: P.toum,
      k: P.vert,
    },
  },
  /** Garlic sauce cup, the pickup: Toum, and the engine gives it an Avocat glow. */
  cup: {
    rows: [
      "..LLLL..",
      ".LLLLLL.",
      "CCCCCCCC",
      "cWWWWWWc",
      "cWWWWWWc",
      ".cWWWWc.",
      ".cWWWWc.",
      "..cccc..",
    ],
    palette: {
      L: P.toum,
      C: mix(P.toum, P.vert, 0.15),
      W: P.toum,
      c: mix(P.toum, P.vert, 0.3),
    },
  },
  /** GAME-13: a plain soda can. No brand name or logo until Boustan confirms the rights. */
  can: {
    rows: [
      ".ssssss.",
      "SssssssS",
      "RRRRRRRr",
      "RhRRRRRr",
      "RhRRRRRr",
      "RhRRRRRr",
      "RhRRRRRr",
      "RhRRRRRr",
      "RRRRRRRr",
      "SssssssS",
      ".SSSSSS.",
    ],
    palette: {
      s: mix(P.toum, P.vert, 0.15),
      S: mix(P.toum, P.vert, 0.4),
      R: P.tomate,
      r: mix(P.tomate, P.vert, 0.35),
      h: mix(P.tomate, P.toum, 0.4),
    },
  },
} satisfies Record<string, PixelArt>;

export type ArtName = keyof typeof ART;
