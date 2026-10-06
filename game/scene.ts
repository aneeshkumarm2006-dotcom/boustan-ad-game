/**
 * Pre-rendered Montreal night backdrop from the reference: sky and moon, Mount Royal with its
 * cross, a skyline, and a row of storefronts with French signs (GAME-12). Everything here is
 * cosmetic, so it may use unseeded randomness.
 */
import { ART, type PixelArt } from "./pixel-art";

export const BRAND = {
  red: "#E1251B",
  cream: "#F3EFEA",
  green: "#073F36",
  charcoal: "#252525",
};

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const x = c.getContext("2d");
  if (x) x.imageSmoothingEnabled = false;
  return c;
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const x = c.getContext("2d");
  if (!x) throw new Error("2D canvas unavailable");
  return x;
}

export function spriteFrom(art: PixelArt): HTMLCanvasElement {
  const c = makeCanvas(art.rows[0].length, art.rows.length);
  const x = ctx2d(c);
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

/** Old-school LCG for the skyline, so it looks the same on every load. */
function lcg(seed: number): () => number {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

export interface Backdrop {
  sky: HTMLCanvasElement;
  mount: HTMLCanvasElement;
  skyline: HTMLCanvasElement;
  stars: { x: number; y: number; sp: number; ph: number }[];
  /** Built once the pixel font is loaded, since the signs are text. */
  shops: HTMLCanvasElement | null;
}

export function buildBackdrop(W: number, H: number, ground: number): Backdrop {
  const sky = makeCanvas(W, H);
  {
    const x = ctx2d(sky);
    const g = x.createLinearGradient(0, 0, 0, ground);
    g.addColorStop(0, "#08061a");
    g.addColorStop(0.55, "#1e1240");
    g.addColorStop(1, "#4a1d52");
    x.fillStyle = g;
    x.fillRect(0, 0, W, H);
    const mx = W - 58;
    const my = 30;
    const mg = x.createRadialGradient(mx, my, 4, mx, my, 28);
    mg.addColorStop(0, "rgba(255,242,194,.25)");
    mg.addColorStop(1, "rgba(255,242,194,0)");
    x.fillStyle = mg;
    x.fillRect(mx - 30, my - 30, 60, 60);
    x.fillStyle = "#fff2c2";
    for (let j = -9; j <= 9; j++) {
      const hw = Math.round(Math.sqrt(81 - j * j));
      x.fillRect(mx - hw, my + j, hw * 2, 1);
    }
    x.fillStyle = "#e8d9a3";
    x.fillRect(mx - 4, my - 3, 3, 3);
    x.fillRect(mx + 3, my + 2, 2, 2);
    x.fillRect(mx - 1, my + 5, 2, 2);
  }

  const stars = Array.from({ length: 46 }, () => ({
    x: Math.floor(Math.random() * W),
    y: Math.floor(Math.random() * (ground - 60)),
    sp: 1 + Math.random() * 2,
    ph: Math.random() * 6,
  }));

  // Mount Royal, cross lit.
  const mount = makeCanvas(900, H);
  {
    const x = ctx2d(mount);
    x.fillStyle = "#170f30";
    x.beginPath();
    x.moveTo(220, ground);
    for (let i = 0; i <= 400; i += 4) {
      const k = i / 400;
      x.lineTo(220 + i, ground - 22 - 64 * Math.pow(Math.sin(Math.PI * k), 0.9));
    }
    x.lineTo(620, ground);
    x.closePath();
    x.fill();
    const cx = 420;
    const cy = ground - 86;
    const g = x.createRadialGradient(cx, cy - 5, 1, cx, cy - 5, 16);
    g.addColorStop(0, "rgba(255,242,194,.45)");
    g.addColorStop(1, "rgba(255,242,194,0)");
    x.fillStyle = g;
    x.fillRect(cx - 16, cy - 21, 32, 32);
    x.fillStyle = "#fff2c2";
    x.fillRect(cx, cy - 10, 1, 10);
    x.fillRect(cx - 2, cy - 7, 5, 1);
  }

  const skyline = makeCanvas(640, H);
  {
    const w = 640;
    const x = ctx2d(skyline);
    const r = lcg(11);
    let px = 0;
    while (px < w) {
      const bw = 14 + Math.floor(r() * 24);
      const bh = 34 + Math.floor(r() * 46);
      const by = ground - bh;
      const col = r() < 0.5 ? "#1f1842" : "#261c4e";
      const wins: [number, number, string][] = [];
      for (let wy = by + 4; wy < ground - 4; wy += 5) {
        for (let wx = 3; wx < bw - 3; wx += 4) {
          const q = r();
          if (q < 0.28) wins.push([wx, wy, q < 0.05 ? "#7fd4ff" : "#ffd36b"]);
        }
      }
      const antenna = r() < 0.25;
      const draw = (ox: number) => {
        x.fillStyle = col;
        x.fillRect(ox, by, bw, bh);
        x.fillStyle = "rgba(255,255,255,.06)";
        x.fillRect(ox, by, bw, 1);
        for (const [wx, wy, wc] of wins) {
          x.fillStyle = wc;
          x.globalAlpha = 0.75;
          x.fillRect(ox + wx, wy, 2, 2);
        }
        x.globalAlpha = 1;
        if (antenna) {
          x.fillStyle = col;
          x.fillRect(ox + (bw >> 1), by - 7, 1, 7);
          x.fillStyle = "#ff3b3b";
          x.fillRect(ox + (bw >> 1), by - 8, 1, 1);
        }
      };
      draw(px);
      if (px + bw > w) draw(px - w);
      px += bw + Math.floor(r() * 3);
    }
  }

  return { sky, mount, skyline, stars, shops: null };
}

interface ShopStyle {
  wall: string;
  awning: [string, string];
  neon: string;
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
const AWNINGS: [string, string][] = [
  ["#e2231a", "#fff7e6"],
  ["#2d9b55", "#fff7e6"],
  ["#ffc93c", "#3a1f4f"],
  ["#ff5c8a", "#fff7e6"],
  ["#3a7bd5", "#fff7e6"],
];
const WALLS = ["#3a1f4f", "#2c2a57", "#4a2340", "#23324d", "#3b2a2a"];
const NEONS = ["#ff5c8a", "#4cd07d", "#ffc93c", "#7fd4ff", "#ff7a1a"];
/** The Boustan storefront wears the brand palette (GAME-12). */
const BOUSTAN_STYLE: ShopStyle = {
  wall: BRAND.green,
  awning: [BRAND.red, BRAND.cream],
  neon: BRAND.cream,
};

export function buildShops(H: number, ground: number, font: string): HTMLCanvasElement {
  const measure = ctx2d(makeCanvas(4, 4));
  measure.font = `8px ${font}`;
  const specs = SIGNS.map((name, i) => {
    const tw = Math.ceil(measure.measureText(name).width);
    const style: ShopStyle =
      name === "BOUSTAN"
        ? BOUSTAN_STYLE
        : {
            wall: WALLS[i % WALLS.length],
            awning: AWNINGS[i % AWNINGS.length],
            neon: NEONS[i % NEONS.length],
          };
    return {
      name,
      tw,
      w: Math.max(tw + 20, 72 + ((i * 37) % 40)),
      h: 46 + ((i * 13) % 14),
      ...style,
    };
  });
  const LAMP = 16;
  const total = specs.reduce((a, s) => a + s.w + LAMP, 0);
  const c = makeCanvas(total, H);
  const x = ctx2d(c);
  let px = 0;
  for (const s of specs) {
    const top = ground - s.h;
    x.fillStyle = s.wall;
    x.fillRect(px, top, s.w, s.h);
    x.fillStyle = "rgba(255,255,255,.08)";
    x.fillRect(px, top, s.w, 2);
    x.fillStyle = "rgba(0,0,0,.28)";
    x.fillRect(px + s.w - 2, top, 2, s.h);
    const winY = top + 21;
    const winH = s.h - 25;
    const winW = Math.floor(s.w * 0.5);
    x.globalAlpha = 0.55;
    x.fillStyle = "#ffcf7a";
    x.fillRect(px + 6, winY, winW, winH);
    x.globalAlpha = 1;
    x.fillStyle = "rgba(0,0,0,.35)";
    x.fillRect(px + 6 + (winW >> 1), winY, 1, winH);
    x.fillRect(px + 6, winY + (winH >> 1), winW, 1);
    const dw = 12;
    const dx = px + s.w - dw - 8;
    x.fillStyle = "#140f26";
    x.fillRect(dx, top + 19, dw, s.h - 19);
    x.globalAlpha = 0.35;
    x.fillStyle = "#ffcf7a";
    x.fillRect(dx + 2, top + 21, dw - 4, 9);
    x.globalAlpha = 1;
    for (let i = 0; i < s.w - 4; i += 4) {
      x.fillStyle = s.awning[(i / 4) & 1];
      x.fillRect(px + 2 + i, top + 13, Math.min(4, s.w - 4 - i), 5);
    }
    x.fillStyle = "rgba(0,0,0,.35)";
    x.fillRect(px + 2, top + 18, s.w - 4, 1);
    x.font = `8px ${font}`;
    x.textBaseline = "top";
    x.shadowColor = s.neon;
    x.shadowBlur = 6;
    x.fillStyle = s.neon;
    // Accented capitals (É) rise above the cap height, so signs sit one pixel lower.
    x.fillText(s.name, px + Math.floor((s.w - s.tw) / 2), top + 4);
    x.shadowBlur = 0;
    px += s.w;
    const lx = px + 7;
    const g = x.createRadialGradient(lx + 1, ground - 49, 1, lx + 1, ground - 49, 28);
    g.addColorStop(0, "rgba(255,220,140,.32)");
    g.addColorStop(1, "rgba(255,220,140,0)");
    x.fillStyle = g;
    x.fillRect(lx - 28, ground - 78, 58, 60);
    x.fillStyle = "#120d24";
    x.fillRect(lx, ground - 52, 2, 52);
    x.fillRect(lx - 3, ground - 53, 8, 2);
    x.fillStyle = "#ffe9a8";
    x.fillRect(lx - 2, ground - 51, 6, 2);
    px += LAMP;
  }
  return c;
}

/** Soft radial glow, pre-rendered once instead of building a gradient every frame. */
export function glowSprite(radius: number, rgb: string, alpha: number): HTMLCanvasElement {
  const size = radius * 2;
  const c = makeCanvas(size, size);
  const x = ctx2d(c);
  const g = x.createRadialGradient(radius, radius, 1, radius, radius, radius);
  g.addColorStop(0, `rgba(${rgb},${alpha})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  return c;
}

/** Left-edge heat vignette, drawn with globalAlpha = heat level. */
export function heatSprite(H: number): HTMLCanvasElement {
  const c = makeCanvas(140, H);
  const x = ctx2d(c);
  const g = x.createLinearGradient(0, 0, 140, 0);
  g.addColorStop(0, "rgba(255,80,20,0.28)");
  g.addColorStop(1, "rgba(255,80,20,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, 140, H);
  return c;
}
