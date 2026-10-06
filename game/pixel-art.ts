/**
 * Pixel art as row strings plus a palette, from the reference prototype. Pure data, so React
 * icons (PixelIcon) and the canvas sprites draw from the same source.
 */

export interface PixelArt {
  rows: readonly string[];
  palette: Readonly<Record<string, string>>;
}

const CHICKEN: Record<string, string> = {
  W: "#fff7e6",
  w: "#d8ccb6",
  S: "#b9ad99",
  R: "#ff3b3b",
  Y: "#ffc93c",
  O: "#ff9a1f",
  K: "#1a1020",
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
    palette: { T: "#e3b268", t: "#f6d9a0", C: "#a85a22", g: "#4cd07d", r: "#ff5c8a", P: "#fffaf0" },
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
    palette: { F: "#a0662e", f: "#d39a55", d: "#5c3a17" },
  },
  /**
   * Flying garlic potato, an obstacle. GAME-11: it must not read as a pickup, so unlike the
   * reference it is browner, outlined in dark brown and has an angry face, and it never glows.
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
      o: "#3d1f08",
      G: "#c9862f",
      g: "#e8a94a",
      h: "#8a5418",
      e: "#fff7e6",
      k: "#1a1020",
    },
  },
  /** Garlic sauce cup, the pickup. */
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
    palette: { L: "#fff3c4", C: "#e9e4d8", W: "#ffffff", c: "#bdb6a8" },
  },
  /** GAME-13: a plain red soda can. No brand name or logo until Boustan confirms the rights. */
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
    palette: { s: "#d9dde6", S: "#8a8f9c", R: "#e1251b", r: "#a8170f", h: "#ff8a80" },
  },
} satisfies Record<string, PixelArt>;

export type ArtName = keyof typeof ART;
