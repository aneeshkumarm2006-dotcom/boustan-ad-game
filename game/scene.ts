/**
 * Pre-rendered Montreal night backdrop from the reference: moon and sky, Mount Royal with its
 * cross, a skyline, and a row of storefronts with French signs (GAME-12), all in the Boustan
 * palette (guide de style: Vert and Toum, one Navet accent, nothing else). Everything here is
 * cosmetic, so it may use unseeded randomness.
 *
 * The big strips are built at k times the logical size (Game.fit picks k from the screen), so
 * text and the logo stay sharp; their drawing code is in logical px and the engine draws them
 * back at their logical size. Sprites stay 1x and are scaled up without smoothing.
 */
import { PALETTE as P, WORDMARK, alpha, mix } from "@/lib/brand";
import { ART, type PixelArt } from "./pixel-art";

/** Black at 60%: the guide's only shadow. Hard, the same shape, offset straight down. */
export const SHADOW = alpha("#000000", 0.6);

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const x = c.getContext("2d");
  if (!x) throw new Error("2D canvas unavailable");
  return [c, x];
}

export function spriteFrom(art: PixelArt): HTMLCanvasElement {
  const [c, x] = canvas(art.rows[0].length, art.rows.length);
  art.rows.forEach((row, j) => {
    [...row].forEach((ch, i) => {
      const color = art.palette[ch];
      if (color) {
        x.fillStyle = color;
        x.fillRect(i, j, 1, 1);
      }
    });
  });
  return c;
}

export type Sprites = { [K in keyof typeof ART]: HTMLCanvasElement };

export function buildSprites(): Sprites {
  const out = {} as Sprites;
  for (const key of Object.keys(ART) as (keyof typeof ART)[]) out[key] = spriteFrom(ART[key]);
  return out;
}

/** A strip of the scene: `c` is logical `w` x `h` px at k-times resolution, drawn at row `y`. */
export interface Layer {
  c: HTMLCanvasElement;
  w: number;
  h: number;
  y: number;
}

/**
 * A strip that stands on the ground line and rises `h` px above it. Its context draws in the
 * scene's logical px, so the strip can be as short as what it holds (less to blit each frame).
 */
function layer(w: number, h: number, ground: number, k: number): [Layer, CanvasRenderingContext2D] {
  const [c, x] = canvas(w * k, h * k);
  x.scale(k, k);
  x.translate(0, h - ground);
  return [{ c, w, h, y: ground - h }, x];
}

/** Old-school LCG for the skyline, so it looks the same on every load. */
function lcg(seed: number): () => number {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

/** The sky is flat bands, a touch lighter towards the horizon (fractions of the ground row). */
export const SKY_CUTS = [0, 0.34, 0.58, 0.8];
export const SKY = [0, 0.03, 0.06, 0.09].map((t) => mix(P.vert, P.toum, t));

/** A pixel-art disc, `d` px across. */
function disc(x: CanvasRenderingContext2D, d: number, color: string): void {
  x.fillStyle = color;
  for (let j = 0; j < d; j++) {
    for (let i = 0; i < d; i++) {
      if ((i + 0.5 - d / 2) ** 2 + (j + 0.5 - d / 2) ** 2 <= (d / 2 - 0.1) ** 2)
        x.fillRect(i, j, 1, 1);
    }
  }
}

/** Toum disc with craters, 20 px across. */
export function moonSprite(): HTMLCanvasElement {
  const [c, x] = canvas(20, 20);
  disc(x, 20, P.toum);
  x.fillStyle = mix(P.toum, P.vert, 0.15);
  x.fillRect(6, 7, 3, 3);
  x.fillRect(13, 12, 2, 2);
  x.fillRect(9, 15, 2, 2);
  return c;
}

/**
 * The doner cone, one frame per colour phase (the stripes crawl as the spit turns): browns from
 * Tomate and Poivron deepened with Vert, each with a dark and a lit streak.
 */
export function meatSprites(): HTMLCanvasElement[] {
  const browns = [0.3, 0.4, 0.5, 0.6].map((t) => mix(mix(P.poivron, P.tomate, 0.3), P.vert, t));
  return browns.map((_, phase) => {
    const [c, x] = canvas(26, 46);
    for (let r = 0; r < 46; r++) {
      const w = Math.round(26 - (r / 45) * 12);
      const lx = 13 - (w >> 1);
      const brown = browns[(Math.floor(r / 2) + phase) & 3];
      x.fillStyle = brown;
      x.fillRect(lx, r, w, 1);
      x.fillStyle = mix(brown, P.vert, 0.4);
      x.fillRect(lx, r, Math.ceil(w * 0.22), 1);
      x.fillStyle = mix(brown, P.hummus, 0.35);
      x.fillRect(lx + Math.floor(w * 0.58), r, Math.ceil(w * 0.14), 1);
    }
    return c;
  });
}

/**
 * Vert disc behind a pickup: the Toum cup keeps a dark backdrop even in front of the bright
 * Boustan wall (GAME-11), and the Avocat glow rings it.
 */
export function plateSprite(): HTMLCanvasElement {
  const [c, x] = canvas(14, 14);
  disc(x, 14, P.vert);
  return c;
}

/** An étincelle: `r` is the length of its arms in px (1 to 3), `hot` stars are Avocat. */
export interface Star {
  x: number;
  y: number;
  sp: number;
  ph: number;
  r: number;
  hot: boolean;
}

export function makeStars(W: number, ground: number): Star[] {
  const stars: Star[] = [];
  const n = Math.round(ground / 5); // about 30 in landscape, more in the taller portrait sky
  while (stars.length < n) {
    const x = 5 + Math.floor(Math.random() * (W - 10));
    const y = 5 + Math.floor(Math.random() * (ground - 70));
    if (Math.abs(x - (W - 58)) < 18 && Math.abs(y - 30) < 18) continue; // clear of the moon
    stars.push({
      x,
      y,
      sp: 1 + Math.random() * 2,
      ph: Math.random() * 6,
      r: stars.length % 5 < 2 ? 3 : 2,
      hot: stars.length % 7 === 3,
    });
  }
  return stars;
}

export interface Backdrop {
  mount: Layer;
  skyline: Layer;
  /** Built once the fonts are loaded, since the signs are text. */
  shops: Layer | null;
}

export function buildBackdrop(ground: number, k: number): Backdrop {
  // Mount Royal, cross lit.
  const [mount, mx] = layer(900, 98, ground, k);
  mx.fillStyle = mix(P.vert, P.toum, 0.11);
  for (let i = 0; i < 400; i++) {
    const h = Math.round(22 + 64 * Math.pow(Math.sin((Math.PI * (i + 0.5)) / 400), 0.9));
    mx.fillRect(220 + i, ground - h, 1, h);
  }
  mx.fillStyle = P.toum;
  mx.fillRect(420, ground - 96, 1, 10);
  mx.fillRect(418, ground - 93, 5, 1);

  const w = 640;
  const [skyline, x] = layer(w, 88, ground, k);
  const r = lcg(11);
  let px = 0;
  while (px < w) {
    const bw = 14 + Math.floor(r() * 24);
    const bh = 34 + Math.floor(r() * 46);
    const by = ground - bh;
    const col = mix(P.vert, P.toum, r() < 0.5 ? 0.15 : 0.2);
    const wins: [number, number, string][] = [];
    for (let wy = by + 4; wy < ground - 4; wy += 5) {
      for (let wx = 3; wx < bw - 3; wx += 4) {
        const q = r();
        if (q < 0.24) wins.push([wx, wy, q < 0.04 ? P.avocat : q < 0.1 ? P.toum : P.hummus]);
      }
    }
    const antenna = r() < 0.25;
    const draw = (ox: number) => {
      x.fillStyle = col;
      x.fillRect(ox, by, bw, bh);
      x.fillStyle = mix(col, P.toum, 0.14);
      x.fillRect(ox, by, bw, 1);
      for (const [wx, wy, wc] of wins) {
        x.fillStyle = wc;
        x.fillRect(ox + wx, wy, 2, 2);
      }
      if (antenna) {
        x.fillStyle = col;
        x.fillRect(ox + (bw >> 1), by - 7, 1, 7);
        x.fillStyle = P.toum;
        x.fillRect(ox + (bw >> 1), by - 8, 1, 1);
      }
    };
    draw(px);
    if (px + bw > w) draw(px - w);
    px += bw + Math.floor(r() * 3);
  }

  return { mount, skyline, shops: null };
}

const SIGNS = [
  "SHAWARMA",
  "DÉPANNEUR",
  "BOUSTAN",
  "FALAFEL",
  "OUVERT",
  "BAGELS",
  "TOUM",
  "POUTINE",
];
/** How far each neighbour's wall is lifted from Vert towards Toum. */
const WALLS = [0.24, 0.32, 0.28, 0.35, 0.22].map((t) => mix(P.vert, P.toum, t));
const SIGN_PX = 9;
const BULKHEAD = 14;
const LAMP = 16;

/** The storefront strip: muted neighbours, and Boustan as the one bright thing (Toum and Navet). */
export function buildShops(ground: number, font: string, k: number): Layer {
  const [, measure] = canvas(4, 4);
  measure.font = `600 ${SIGN_PX}px ${font}`;
  const specs = SIGNS.map((name, i) => {
    const tw = Math.ceil(measure.measureText(name).width);
    const brand = name === "BOUSTAN";
    return {
      name,
      tw,
      brand,
      w: brand ? 116 : Math.max(tw + 20, 72 + ((i * 37) % 40)),
      h: brand ? 70 : 52 + ((i * 13) % 14),
      wall: brand ? P.toum : WALLS[i % WALLS.length],
    };
  });
  const total = specs.reduce((a, s) => a + s.w + LAMP, 0);
  const [l, x] = layer(total, 72, ground, k);
  // Built here, not at module level: the server also loads this file, and it has no Path2D.
  const wordmark = new Path2D(WORDMARK.d);
  let px = 0;
  for (const s of specs) {
    const top = ground - s.h;
    const { wall, brand } = s;
    const sign = brand ? 19 : 13; // height of the sign band
    const awn = top + sign;
    const shade = mix(wall, P.vert, 0.4);
    x.fillStyle = wall;
    x.fillRect(px, top, s.w, s.h);
    x.fillStyle = mix(wall, P.toum, 0.14);
    x.fillRect(px, top, s.w, 2);
    x.fillStyle = shade;
    x.fillRect(px + s.w - 2, top, 2, s.h);

    // Window with mullions, then the painted base panel (a dark backdrop for the chicken).
    const winY = awn + 8;
    const winH = ground - BULKHEAD - 2 - winY;
    const winW = Math.floor(s.w * 0.5);
    x.fillStyle = brand ? P.vert : mix(wall, P.vert, 0.45);
    x.fillRect(px + 5, winY - 1, winW + 2, winH + 2);
    x.fillStyle = mix(wall, P.hummus, brand ? 0.6 : 0.5);
    x.fillRect(px + 6, winY, winW, winH);
    x.fillStyle = brand ? P.vert : mix(wall, P.vert, 0.45);
    x.fillRect(px + 6 + (winW >> 1), winY, 1, winH);
    x.fillRect(px + 6, winY + (winH >> 1), winW, 1);
    x.fillStyle = brand ? P.vert : mix(wall, P.vert, 0.55);
    x.fillRect(px, ground - BULKHEAD, s.w, BULKHEAD);

    const dw = 12;
    const dx = px + s.w - dw - 8;
    x.fillStyle = mix(P.vert, "#000000", 0.3);
    x.fillRect(dx, awn + 6, dw, ground - awn - 6);
    x.fillStyle = mix(P.vert, P.hummus, 0.4);
    x.fillRect(dx + 2, awn + 8, dw - 4, 10);

    for (let i = 0; i < s.w - 4; i += 4) {
      x.fillStyle = brand ? [P.navet, P.toum][(i / 4) & 1] : [P.toum, P.vert][(i / 4) & 1];
      x.fillRect(px + 2 + i, awn, Math.min(4, s.w - 4 - i), 5);
    }
    x.fillStyle = brand ? P.vert : mix(wall, P.vert, 0.5);
    x.fillRect(px + 2, awn - 1, s.w - 4, 1);
    x.fillStyle = SHADOW;
    x.fillRect(px + 2, awn + 5, s.w - 4, 2);

    if (brand) {
      // The official wordmark, plain Vert on Toum: scaled uniformly, never restyled.
      const sc = 11 / WORDMARK.h;
      x.save();
      x.translate(px + (s.w - WORDMARK.w * sc) / 2, top + 4);
      x.scale(sc, sc);
      x.fillStyle = P.vert;
      x.fill(wordmark);
      x.restore();
    } else {
      x.fillStyle = mix(wall, P.vert, 0.5);
      x.fillRect(px + 3, top + 3, s.w - 8, 9);
      x.font = `600 ${SIGN_PX}px ${font}`;
      x.textBaseline = "alphabetic";
      x.fillStyle = P.toum;
      x.fillText(s.name, px + (s.w - s.tw) / 2, top + 10.5);
    }
    px += s.w;

    // Street lamp between shops: a flat post and a lit hummus head, no glow.
    const lx = px + 7;
    x.fillStyle = mix(P.vert, P.toum, 0.3);
    x.fillRect(lx, ground - 52, 2, 52);
    x.fillRect(lx - 3, ground - 53, 8, 2);
    x.fillStyle = P.hummus;
    x.fillRect(lx - 2, ground - 51, 6, 2);
    px += LAMP;
  }
  return l;
}

/** Soft radial glow, pre-rendered once (at k times size) instead of building a gradient per frame. */
export function glowSprite(radius: number, color: string, a: number, k: number): HTMLCanvasElement {
  const size = radius * 2 * k;
  const [c, x] = canvas(size, size);
  const g = x.createRadialGradient(size / 2, size / 2, k, size / 2, size / 2, size / 2);
  g.addColorStop(0, alpha(color, a));
  g.addColorStop(0.5, alpha(color, a * 0.55));
  g.addColorStop(1, alpha(color, 0));
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  return c;
}
