/**
 * Boustan brand tokens, from the guide de style (version 1.1, automne 2025). The CSS twin of the
 * palette lives in app/globals.css (:root); keep the two in step.
 *
 * Rules that bind every screen, email and canvas draw (guide: "Palette de couleurs" and
 * "Application de la couleur"):
 * - Vert Boustan and Toum are the two main colours and the preferred text colours.
 * - Navet is the accent: used sparingly, to draw the eye.
 * - Hummus, Poivron, Tomate, Avocat and Laitue are secondary: use with restraint, one dominant
 *   colour per visual, never mix them for decoration.
 * - No other colours. Legibility always wins (see the contrast notes in globals.css).
 */
export const PALETTE = {
  /** Vert Boustan, PMS 3308 C. Main colour. */
  vert: "#073F36",
  /** Toum, PMS 9226 C. Main colour. */
  toum: "#F4EEDF",
  /** Navet, Rhodamine Red C. Accent. */
  navet: "#ED2B9A",
  /** Hummus, PMS 4029 C. */
  hummus: "#EEC088",
  /** Poivron, PMS 715 C. */
  poivron: "#F48431",
  /** Tomate, PMS 179 C. */
  tomate: "#E2412B",
  /** Avocat, PMS 379 C. */
  avocat: "#EAF864",
  /** Laitue, PMS 2271 C. */
  laitue: "#39B54A",
} as const;

export type PaletteName = keyof typeof PALETTE;

function channels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `a` blended towards `b` by `t` (0..1), as a hex colour. For shading pixel art from the palette. */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = channels(a);
  const [br, bg, bb] = channels(b);
  const m = (x: number, y: number) => Math.round(x + (y - x) * t);
  return `#${[m(ar, br), m(ag, bg), m(ab, bb)].map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** `hex` as an rgba() string, for glows and overlays. */
export function alpha(hex: string, a: number): string {
  const [r, g, b] = channels(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * Official artwork, taken from the vector pages of the guide ("Logotype" and "Symbole").
 * The guide forbids redrawing, recolouring outside the palette, outlining, distorting, shadowing,
 * rotating or swapping the font ("Utilisations incorrectes"): draw these paths as they are.
 * `d` is in a box of `w` x `h` units that starts at 0,0.
 */
export const WORDMARK = {
  w: 1092,
  h: 223,
  d: "M 944.8 216.5 C 975.2 146.9 1001.2 116.4 1039.6 107.4 C 1033.6 128.4 1010.1 169.1 994.6 191.4 L 1035.9 216.5 C 1068.2 165.3 1085.7 120.5 1092 90.4 C 1064.2 55.3 1030.4 57.6 991.8 97.4 L 997.2 101.2 C 1003.5 87.5 1009.5 76.1 1015.3 65.5 L 979.2 43.6 C 955.1 82.8 926.5 128.4 903.3 189.3 L 944.8 216.5 Z M 901.5 49.4 C 871.8 109.1 839.4 146.3 811 153.9 C 824.8 103.9 855.7 76.9 884.7 90.7 C 889.5 92.7 891.8 89.2 894.4 83.7 C 895.5 80.5 896.1 79.3 896.1 79.3 L 902.4 79.9 C 888.1 51.8 855.7 40.7 830.8 53.8 C 787 77.2 764.4 118.2 757.8 184.6 C 785.6 210.7 817.1 203.4 853.7 163.3 L 848 159.8 C 843.1 172.3 837.7 185.8 837.4 203.1 L 879.2 215.4 C 887.8 168 912.4 124.1 941.4 76.4 L 901.5 49.4 Z M 474.8 48 C 445.3 107.4 412.7 144.8 384 152.4 C 390.1 132.5 411.3 95.1 432.7 72.8 L 391.8 46.5 C 350.8 99.5 331.1 144.2 331.1 183.5 C 358.8 208.9 390.3 201.6 427 161.8 L 421.3 158.3 C 416.4 170.9 411 184 410.4 201.6 L 452.2 213.6 C 460.8 166.5 484 123.2 514.3 75.5 L 474.8 48 Z M 649.5 197.2 C 670.4 217.1 695.3 216.8 741.5 196.9 L 742 151.6 C 716.5 159.8 699.9 163.8 685 166.8 C 690.5 150.4 698.2 131.9 708.8 110.6 C 738.9 109.4 757.5 105.6 769.2 101.5 L 761.2 63.5 C 751.5 66.1 739.7 67.6 731.7 69 C 737.5 60 743.8 50.9 750.3 41.5 L 717.1 13.1 C 681.6 57 646.7 124.6 630.9 179.7 L 649.5 197.2 Z M 480.6 172.3 C 508.3 201 533 212.7 561 210.7 C 593.4 208.3 617.2 184.6 619.5 151 C 598.3 134 581.9 119.7 572.2 109.1 C 579.9 96.8 591.1 87.5 607.7 80.4 C 606.3 83.1 603.7 86.6 600.6 91.3 C 595.1 98.9 590 106.8 589.4 110.9 L 625.5 136.3 C 636.6 111.5 642.4 96 652.1 76.6 L 619.2 54.7 C 601.7 43 586.2 40.1 569.1 51.5 C 543.9 68.5 528.1 91 514.6 116.7 C 521.2 125.8 533.3 134.9 551 147.8 C 557 152.2 563.6 156.8 570.8 162.4 C 566.2 166.5 561.9 168.5 557.6 168.8 C 542.7 169.1 524.1 157.7 501.8 133.4 L 480.6 172.3 Z M 234.3 171.2 C 234 132.5 258.3 94.2 290.4 83.1 C 290.4 118.2 265.2 157.1 234.3 171.2 Z M 262.9 208.6 C 307.9 184.9 333.9 137.8 336.5 77.2 C 300.7 49.1 281.5 37.7 257.2 50.6 C 208.5 75.8 183 127.3 189.9 187 C 215.6 205.1 239.7 220.9 262.9 208.6 Z M 93.9 97.4 C 99.1 88.1 106.5 75.2 116.6 58.8 L 85.9 38.3 L 83.9 44.8 C 113.1 46.5 137.8 50.9 157.8 57.9 C 140.3 76.4 119.7 87.8 93.9 97.4 Z M 58.7 175.6 C 63.6 162.1 69.6 147.8 76.5 132.5 C 91.1 136.9 110.3 144.5 121.7 152.7 C 105.1 163.6 84.2 171.2 58.7 175.6 Z M 64.4 221.8 C 136.6 208 177.3 178.2 176.1 138.7 C 165.8 131.4 154.1 124.6 144.3 119.4 C 171.8 106.5 194.2 88.3 211.4 64.9 C 199.6 4.4 145.8 -4.7 46.7 1.7 L 36.4 45.3 C 43.8 43.9 55 43.6 69.9 43.9 C 41.5 88.9 18.3 139.6 0 196.6 C 30.9 219.7 40.4 225.9 64.4 221.8 Z M 64.4 221.8",
} as const;

export const SYMBOL = {
  w: 258.9,
  h: 374,
  d: "M 143.6 333.2 C 136.6 333.2 130.1 333.2 121.3 333.6 L 121.7 365.4 L 143.6 374 L 143.6 333.2 Z M 123.5 295.6 C 175.2 297.8 201.8 272.4 223 201.5 L 126.1 179.3 L 125.7 177.9 C 225.9 189 235 177.5 252.8 112.4 C 222.6 100.6 161.8 86.6 119.9 82.7 C 49.2 76.2 8.7 99.9 18.2 142.4 C 21.1 155.3 39 205.8 44.4 220.8 C 58.6 228.7 70.7 235.1 91.8 239.8 L 92.9 238.7 C 77.2 218 58.6 153.5 56.5 140.3 C 51 106.3 72.1 103.4 96.5 108.4 C 150.5 119.5 178.2 127.4 203.3 134.6 C 199.6 156 181.8 154.6 164.3 154.6 L 83.1 154.6 C 84.5 162.5 88.5 173.9 94 188.3 C 98.7 201.9 101.6 206.5 117.3 210.4 C 147.9 219 186.9 229.1 201.5 233 C 193.8 254.1 150.5 258.4 121.3 258.4 C 92.2 258.4 71.8 252.3 51.7 240.2 L 50.6 240.9 C 57.9 261.3 67.4 293.5 123.5 295.6 Z M 82 326.8 C 88.5 336.1 149.4 347.2 178.9 330 L 193.5 287.4 L 191.3 287.4 C 181.8 298.5 157.8 309.9 133.3 310.7 C 109.7 311.4 91.8 307.4 71.8 297.4 L 70.3 298.5 C 73.6 308.2 76.9 320.3 82 326.8 Z M 5.1 106.3 L 6.6 106.3 C 30.2 65.9 89.3 66.9 121.3 68 C 162.9 69.4 209.9 78.7 257.9 96.6 C 267.4 59.4 211.7 33.6 130.1 33.6 C 72.9 33.6 19.3 56.6 0 91.6 Z M 142.1 53 L 142.8 8.9 L 120.6 0 L 119.5 52.6 C 128.2 53 135.2 53 142.1 53 Z M 142.1 53",
} as const;
