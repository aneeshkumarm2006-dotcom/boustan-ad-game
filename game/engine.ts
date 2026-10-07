/**
 * The runner, ported from the reference prototype (PRD §4.1) onto game-core.
 *
 * What changed from the reference:
 * - Obstacles and garlic come from the seeded level (GAME-06). Their positions are functions of
 *   active run time, so they don't depend on frame rate.
 * - Distance comes from the speed curve (SEC-02). A run scores 1 point per metre and 10 per
 *   garlic (game-core/score.ts), counted live in the HUD; milestones are by points (GAME-05).
 * - Pause with a 3-2-1 countdown on resume (GAME-09). Paused time isn't counted.
 * - Canvas text comes from the i18n dictionaries and follows language switches mid-run.
 * - The backing store is a whole multiple k of the 320 px logical canvas (see `fit`), so the
 *   brand fonts and the logo are sharp. Game logic and every coordinate stay in logical px.
 */
import {
  POINTS_PER_GARLIC,
  TUNING,
  createLevel,
  distanceMAt,
  distancePxAt,
  pointsOf,
  pxToMetres,
  speedAt,
  timeAtDistancePx,
  type BaseObstacleType,
  type GarlicSpawn,
  type Level,
  type ObstacleSpawn,
} from "@/game-core";
import type { Translator } from "@/i18n";
import { PALETTE, alpha, mix } from "@/lib/brand";
import type { CanvasFonts } from "./fonts";
import { Sfx, type Sound } from "./audio";
import {
  SHADOW,
  SKY,
  SKY_CUTS,
  buildBackdrop,
  buildShops,
  buildSprites,
  glowSprite,
  makeStars,
  meatSprites,
  moonSprite,
  plateSprite,
  type Backdrop,
  type Layer,
  type Sprites,
  type Star,
} from "./scene";

export type GameState = "title" | "play" | "paused" | "countdown" | "caught" | "over";
export type DeathCause = BaseObstacleType | "creep";

export interface RunResult {
  seed: number;
  /** Metres, from the speed curve at `activeMs` (what the server recomputes). */
  distanceM: number;
  garlic: number;
  hits: number;
  activeMs: number;
  /** 1 per whole metre plus 10 per garlic: the same number the server scores. */
  points: number;
  cause: DeathCause;
}

export interface RunSetup {
  seed: number;
}

export type GameEvent =
  /** The first frame is on screen: the game can be played. */
  | { type: "ready" }
  | { type: "state"; state: GameState }
  | { type: "milestone"; points: number }
  | { type: "over"; result: RunResult };

export interface HudRefs {
  /** Spit meter group; gets data-level="low|mid|high". */
  spit: HTMLElement;
  meterFill: HTMLElement;
  /** Live counts: the run's points so far, and garlic picked up. */
  points: HTMLElement;
  garlic: HTMLElement;
}

export interface GameOptions {
  canvas: HTMLCanvasElement;
  /** Element that takes taps (canvas plus HUD). */
  frame: HTMLElement;
  hud: HudRefs;
  /** CSS font-family lists for text drawn on the canvas. */
  fonts: CanvasFonts;
  translator: Translator;
  portrait: boolean;
  reducedMotion: boolean;
  muted: boolean;
  onEvent: (event: GameEvent) => void;
  /** Space or Enter on the title screen. */
  onRequestStart?: () => void;
}

interface ActiveObstacle {
  spawn: ObstacleSpawn;
  /** Run time when it spawned. */
  t0: number;
  x: number;
  y: number;
  rot: number;
}
interface ActiveGarlic {
  spawn: GarlicSpawn;
  x: number;
  y: number;
  ph: number;
  taken: boolean;
}
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  g: number;
  life: number;
  max: number;
  c: string;
  s: number;
  sway: number;
}
interface FloatText {
  text: () => string;
  x: number;
  y: number;
  color: string;
  size: number;
  life: number;
  max: number;
}

const { view, physics, heat: HEAT, obstacles: OB, speed: SPEED } = TUNING;
const W = view.width;
const COUNTDOWN_S = 3;
/** The backing store is at most this many times the logical size, and this many pixels. */
const MAX_K = 6;
const MAX_PIXELS = 2.1e6;
/** Drawn past the canvas edge so a screen shake never shows the bare canvas. */
const BLEED = 8;

// Guide de style palette: Vert and Toum, Navet as the accent, the rest used with restraint.
const { vert, toum, navet, hummus, poivron, tomate, avocat, laitue } = PALETTE;
const DUST = [mix(vert, toum, 0.3), mix(vert, toum, 0.2)];
const FEATHERS = [toum, mix(toum, vert, 0.12), mix(toum, vert, 0.25)];
const DIM = alpha(vert, 0.7);
const SIDEWALK = mix(vert, toum, 0.16);
const ROAD = mix(vert, "#000000", 0.35);
/** Heat vignette: flat bands from the left edge, Tomate then Poivron, fading out. */
const VIGNETTE = Array.from({ length: 8 }, (_, i) =>
  alpha(i < 2 ? tomate : poivron, 0.34 * (1 - i / 8) ** 2),
);
const VIGNETTE_BAND = 12;
const METAL = [
  mix(toum, vert, 0.15),
  mix(toum, vert, 0.3),
  mix(toum, vert, 0.45),
  mix(toum, vert, 0.6),
];

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)];
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
type Box = { x: number; y: number; w: number; h: number };
const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

const INTERACTIVE = "button, a, input, select, textarea, label, [role='dialog']";
function isInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE) !== null;
}

export class Game {
  private readonly opts: GameOptions;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly sfx: Sfx;
  private readonly sprites: Sprites;
  private readonly moon = moonSprite();
  private readonly plate = plateSprite();
  private readonly meat = meatSprites();
  private readonly resizer: ResizeObserver;
  private cupGlow!: HTMLCanvasElement;
  private spitGlow!: HTMLCanvasElement;
  private t: Translator;
  private H = 0;
  private ground = 0;
  /** Backing store pixels per logical pixel, and the devicePixelRatio it was chosen for. */
  private k = 0;
  private dpr = 0;
  /** Highest k allowed: the frame-time watchdog steps it down on a slow canvas. */
  private kMax = MAX_K;
  /** Frame times (ms) and count in the watchdog's current window. */
  private win = 0;
  private winN = 0;
  private backdrop!: Backdrop;
  private stars: Star[] = [];
  private fontReady = false;
  private raf = 0;
  private last = 0;
  private destroyed = false;
  private readySent = false;

  private _state: GameState = "title";
  private setup: RunSetup | null = null;
  private level: Level | null = null;
  private nextObstacle = 0;
  private nextGarlic = 0;
  private T = 0;
  private runTime = 0;
  /** Run distance in px; positions are measured from it. */
  private dist = 0;
  /** Scrolling distance for the backdrop; keeps going on the title and caught screens. */
  private viewDist = 0;
  private speed: number = SPEED.title;
  private heat = 0;
  private garlic = 0;
  private hits = 0;
  private spitX = -14;
  private obstacles: ActiveObstacle[] = [];
  private cups: ActiveGarlic[] = [];
  private parts: Particle[] = [];
  private texts: FloatText[] = [];
  private milestoneIdx = 0;
  private nextMilestone: number = TUNING.milestonesPts[0];
  private shake = 0;
  private caughtT = 0;
  private countdown = 0;
  private wrap: { x: number; y: number; vy: number; b: number } | null = null;
  private lastPress = -9;
  private wheelRot = 0;
  private lastHit: { type: BaseObstacleType; at: number } | null = null;
  private readonly chick = {
    x: view.chickX,
    y: 0,
    vy: 0,
    onGround: true,
    jumps: 0,
    inv: 0,
    anim: 0,
    visible: true,
  };
  private cheats = { invincible: false, magnet: false };
  private hudCache = { meter: -1, level: "", points: "", garlic: "" };

  constructor(opts: GameOptions) {
    this.opts = opts;
    this.t = opts.translator;
    // The scene covers every pixel, so the canvas can be opaque.
    const ctx = opts.canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
    this.sfx = new Sfx(opts.muted);
    this.sprites = buildSprites();
    this.layout(opts.portrait);
    opts.frame.dataset.running = "false";
    this.resizer = new ResizeObserver(() => {
      if (this.fit()) this.render();
    });
    this.resizer.observe(opts.frame);

    opts.frame.addEventListener("pointerdown", this.onPointerDown, { passive: false });
    window.addEventListener("keydown", this.onKeyDown);
    // Both brand faces are single weights: the condensed one is 600, the display serif 400.
    const { fonts } = opts;
    const ready = () => this.onFontReady();
    if (document.fonts) {
      Promise.all([
        document.fonts.load(`600 8px ${fonts.condensed}`),
        document.fonts.load(`400 8px ${fonts.display}`),
      ]).then(ready, ready);
    } else ready();
    setTimeout(ready, 2500);

    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  get state(): GameState {
    return this._state;
  }

  // ---------- public controls ----------

  start(setup: RunSetup): void {
    this.setup = setup;
    this.level = createLevel(setup.seed);
    this.nextObstacle = 0;
    this.nextGarlic = 0;
    this.runTime = 0;
    this.dist = 0;
    this.speed = SPEED.start;
    this.heat = 0;
    this.garlic = 0;
    this.hits = 0;
    this.obstacles = [];
    this.cups = [];
    this.parts = [];
    this.texts = [];
    this.milestoneIdx = 0;
    this.nextMilestone = TUNING.milestonesPts[0];
    this.shake = 0;
    this.wrap = null;
    this.lastHit = null;
    Object.assign(this.chick, {
      y: this.ground,
      vy: 0,
      onGround: true,
      jumps: 0,
      inv: 0,
      visible: true,
    });
    this.hudCache.points = this.hudCache.garlic = "";
    this.setState("play");
    this.floatText(() => this.t.t("canvas.run"), W / 2, this.ground - 80, avocat, 22, 1);
    this.play("start");
    this.updateHud();
  }

  /** Pauses a run (GAME-09). No effect outside a run. */
  pause(): void {
    if (this._state === "play" || this._state === "countdown") this.setState("paused");
  }

  /** Resumes a paused run after a 3-2-1 countdown. */
  resume(): void {
    if (this._state !== "paused") return;
    this.countdown = COUNTDOWN_S;
    this.setState("countdown");
    this.play("tick");
  }

  jump(): void {
    this.lastPress = this.T;
    if (this._state !== "play") return;
    const c = this.chick;
    if (c.onGround) {
      c.vy = physics.jump;
      c.onGround = false;
      c.jumps = 1;
      this.play("jump");
      this.dust(c.x + 6, this.ground, 4);
    } else if (c.jumps < 2) {
      c.vy = physics.doubleJump;
      c.jumps = 2;
      this.play("jump2");
      this.burst(c.x + 4, c.y - 6, 5, FEATHERS.slice(0, 2), 40, 50, 0.6, 1);
    }
  }

  setTranslator(t: Translator): void {
    this.t = t;
    this.hudCache.points = this.hudCache.garlic = "";
    this.updateHud();
  }

  setMuted(muted: boolean): void {
    this.sfx.muted = muted;
  }

  /** Switches between the portrait and landscape canvas. Ignored during a run. */
  setPortrait(portrait: boolean): void {
    if (this._state !== "title" && this._state !== "over") return;
    if ((this.H === view.heightPortrait) === portrait) return;
    this.layout(portrait);
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.resizer.disconnect();
    this.opts.frame.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("keydown", this.onKeyDown);
  }

  // ---------- test hooks (wired to window.__stc outside production) ----------

  snapshot() {
    return {
      state: this._state,
      runTime: this.runTime,
      activeMs: Math.round(this.runTime * 1000),
      distanceM: pxToMetres(this.dist),
      garlic: this.garlic,
      hits: this.hits,
      heat: this.heat,
      points: this.points(),
    };
  }

  debugSetHeat(h: number): void {
    this.heat = h;
  }

  debugCheat(cheats: Partial<{ invincible: boolean; magnet: boolean }>): void {
    Object.assign(this.cheats, cheats);
  }

  /** Advances the simulation by `seconds` in fixed frames, then renders once. */
  debugRun(seconds: number, fps = 60): void {
    const steps = Math.round(seconds * fps);
    for (let i = 0; i < steps; i++) this.update(1 / fps);
    this.render();
  }

  // ---------- setup ----------

  private layout(portrait: boolean): void {
    this.H = portrait ? view.heightPortrait : view.heightLandscape;
    this.ground = this.H - view.groundOffset;
    this.stars = makeStars(W, this.ground);
    this.chick.y = this.ground;
    this.k = 0; // the canvas height changed: rebuild everything that depends on it
    this.fit();
  }

  /**
   * Makes the backing store a whole multiple k of the logical canvas: enough device pixels for
   * the frame's on-screen width (capped by kMax and MAX_PIXELS), so type and the logo are
   * crisp. Rebuilds what is drawn at k. Returns whether k changed.
   */
  private fit(): boolean {
    const { canvas, frame, fonts } = this.opts;
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    const cap = Math.floor(Math.sqrt(MAX_PIXELS / (W * this.H)));
    const k = Math.max(1, Math.min(this.kMax, cap, Math.ceil((frame.clientWidth * dpr) / W)));
    if (k === this.k) return false;
    this.k = k;
    canvas.width = W * k;
    canvas.height = this.H * k;
    canvas.dataset.logicalW = String(W);
    canvas.dataset.logicalH = String(this.H);
    this.backdrop = buildBackdrop(this.ground, k);
    this.cupGlow = glowSprite(12, avocat, 1, k);
    this.spitGlow = glowSprite(48, poivron, 0.3, k);
    if (this.fontReady) this.backdrop.shops = buildShops(this.ground, fonts.condensed, k);
    return true;
  }

  private onFontReady(): void {
    if (this.fontReady || this.destroyed) return;
    this.fontReady = true;
    this.backdrop.shops = buildShops(this.ground, this.opts.fonts.condensed, this.k);
  }

  private setState(state: GameState): void {
    if (this._state === state) return;
    this._state = state;
    this.opts.frame.dataset.running = String(state === "play" || state === "countdown");
    this.opts.onEvent({ type: "state", state });
  }

  private play(sound: Sound): void {
    this.sfx.play(sound);
  }

  // ---------- input ----------

  private onPointerDown = (e: PointerEvent): void => {
    if (isInteractive(e.target)) return;
    if (this._state === "play") {
      e.preventDefault();
      this.jump();
    } else if (this._state === "paused") {
      e.preventDefault();
      this.resume();
    }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    const target = e.target;
    const onFrame = target === this.opts.frame;
    if (!onFrame && isInteractive(target)) return;
    if (target instanceof HTMLElement && target.isContentEditable) return;
    const k = e.code;
    if (k === "Space" || k === "ArrowUp" || k === "KeyW" || k === "Enter") {
      if (this._state === "play") {
        e.preventDefault();
        if (!e.repeat) this.jump();
      } else if (this._state === "paused") {
        e.preventDefault();
        this.resume();
      } else if (this._state === "title" && !e.repeat) {
        e.preventDefault();
        this.opts.onRequestStart?.();
      }
    } else if (k === "Escape" || k === "KeyP") {
      if (this._state === "play" || this._state === "countdown") {
        e.preventDefault();
        this.pause();
      }
    }
  };

  // ---------- effects ----------

  private burst(
    x: number,
    y: number,
    n: number,
    colors: readonly string[],
    spd: number,
    grav: number,
    life: number,
    size: number,
  ): void {
    for (let i = 0; i < n; i++) {
      this.parts.push({
        x,
        y,
        vx: rand(-1, 1) * spd,
        vy: -Math.random() * spd,
        g: grav,
        life: life * rand(0.6, 1),
        max: life,
        c: pick(colors),
        s: size,
        sway: rand(0, 6),
      });
    }
  }

  private dust(x: number, y: number, n: number): void {
    this.burst(x, y - 1, n, DUST, 30, -10, 0.4, 2);
  }

  private floatText(
    text: () => string,
    x: number,
    y: number,
    color: string,
    size: number,
    life: number,
  ): void {
    this.texts.push({ text, x, y, color, size, life, max: life });
  }

  // ---------- update ----------

  private frame = (now: number): void => {
    if (this.destroyed) return;
    // Zooming or dragging to another screen changes the pixel ratio without resizing the frame.
    if ((window.devicePixelRatio || 1) !== this.dpr) this.fit();
    const gap = now - this.last;
    // A slow canvas (software rendering, an old phone) gives up sharpness, not frames: if a
    // 0.7 s window of play averages under ~36 fps, cut k to what the pixel cost allows (it grows
    // with k squared).
    if (this._state === "play" && gap < 250) {
      this.win += gap;
      this.winN++;
      if (this.win > 700) {
        const avg = this.win / this.winN;
        this.win = this.winN = 0;
        if (avg > 28 && this.k > 2) {
          this.kMax = Math.max(2, Math.floor(this.k * Math.sqrt(24 / avg)));
          this.fit();
        }
      }
    }
    const dt = Math.min(physics.maxFrameS, Math.max(0, gap / 1000));
    this.last = now;
    this.update(dt);
    this.render();
    if (!this.readySent) {
      this.readySent = true;
      this.opts.onEvent({ type: "ready" });
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  private update(dt: number): void {
    this.T += dt;
    const state = this._state;
    if (state === "paused") return;
    if (state === "countdown") {
      const before = Math.ceil(this.countdown);
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.setState("play");
        this.play("go");
      } else if (Math.ceil(this.countdown) !== before) {
        this.play("tick");
      }
      return;
    }

    this.wheelRot += dt * (this.speed / 6);
    if (state === "play") this.stepRun(dt);
    else if (state === "caught") this.stepCaught(dt);
    else if (state === "title") {
      this.speed = SPEED.title;
      this.viewDist += this.speed * dt;
      this.chick.anim += (dt * this.speed) / 10;
    }

    const g = this.ground;
    if (this.wrap) {
      const w = this.wrap;
      w.vy += physics.gravity * 0.8 * dt;
      w.y += w.vy * dt;
      if (w.y >= g) {
        w.y = g;
        if (w.b < 2) {
          w.vy = -90 / (w.b + 1);
          w.b++;
          this.dust(w.x + 7, g, 3);
        } else w.vy = 0;
      }
    }
    const target =
      state === "title"
        ? -10
        : state === "caught" || state === "over"
          ? this.chick.x - 26
          : lerp(-6, 56, this.heat / HEAT.max);
    this.spitX += (target - this.spitX) * Math.min(1, dt * (state === "caught" ? 8 : 3));
    if (state !== "over" && Math.random() < dt * (this.speed / 40)) {
      this.dust(this.spitX + 6 + rand(0, 18), g, 1);
    }

    for (const p of this.parts) {
      p.vy += p.g * dt;
      p.x += (p.vx + (p.s === 2 && p.g > 0 ? Math.sin(this.T * 8 + p.sway) * 10 : 0)) * dt;
      p.y += p.vy * dt;
      p.life -= dt;
    }
    this.parts = this.parts.filter((p) => p.life > 0);
    for (const t of this.texts) {
      t.y -= 12 * dt;
      t.life -= dt;
    }
    this.texts = this.texts.filter((t) => t.life > 0);
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 20);
  }

  private stepRun(dt: number): void {
    const level = this.level;
    const setup = this.setup;
    if (!level || !setup) return;
    const c = this.chick;
    const g = this.ground;

    this.runTime += dt;
    this.speed = speedAt(this.runTime);
    this.dist = distancePxAt(this.runTime);
    this.viewDist = this.dist;
    this.heat = Math.min(
      HEAT.max,
      this.heat + (HEAT.creepBase + this.runTime * HEAT.creepPerS) * dt,
    );

    c.vy += physics.gravity * dt;
    c.y += c.vy * dt;
    if (c.y >= g) {
      c.y = g;
      c.vy = 0;
      if (!c.onGround) {
        c.onGround = true;
        c.jumps = 0;
        this.dust(c.x + 8, g, 3);
        if (this.T - this.lastPress < physics.jumpBufferS) this.jump();
      }
    }
    c.anim += (dt * this.speed) / 14;
    if (c.inv > 0) c.inv -= dt;

    // Spawn what the level placed up to the current distance.
    level.extendTo(this.dist);
    while (
      this.nextObstacle < level.obstacles.length &&
      level.obstacles[this.nextObstacle].at <= this.dist
    ) {
      const spawn = level.obstacles[this.nextObstacle++];
      this.obstacles.push({ spawn, t0: timeAtDistancePx(spawn.at), x: view.spawnX, y: g, rot: 0 });
    }
    while (this.nextGarlic < level.garlic.length && level.garlic[this.nextGarlic].at <= this.dist) {
      const spawn = level.garlic[this.nextGarlic++];
      this.cups.push({
        spawn,
        x: view.spawnX,
        y: g + spawn.dy,
        ph: this.nextGarlic % 6,
        taken: false,
      });
    }

    const cb = { x: c.x + 3, y: c.y - 13, w: 10, h: 12 };
    for (const o of this.obstacles) {
      const s = o.spawn;
      o.x = view.spawnX - (this.dist - s.at) - s.extra * (this.runTime - o.t0);
      if (s.type === "potato") {
        o.y =
          g - OB.potatoHeight + Math.sin(this.runTime * OB.potatoBobRate + s.phase) * OB.potatoBob;
        if (Math.random() < dt * 6) {
          this.parts.push({
            x: o.x + 4,
            y: o.y - 8,
            vx: rand(-5, 5),
            vy: -15,
            g: -5,
            life: 0.5,
            max: 0.5,
            c: alpha(toum, 0.6),
            s: 1,
            sway: 0,
          });
        }
      }
      if (s.type === "falafel") o.rot -= (dt * (this.speed + s.extra)) / 5;
      const box = { x: o.x + 2, y: o.y - s.h + 2, w: s.w - 4, h: s.h - 2 };
      if (c.inv <= 0 && !this.cheats.invincible && overlap(cb, box)) this.hit(s.type);
    }
    this.obstacles = this.obstacles.filter((o) => o.x > -30);

    const reach = { x: cb.x - 2, y: cb.y - 2, w: cb.w + 4, h: cb.h + 4 };
    for (const cup of this.cups) {
      cup.x = view.spawnX - (this.dist - cup.spawn.at);
      const touching = overlap(reach, { x: cup.x, y: cup.y - 8, w: 8, h: 8 });
      const magnet = this.cheats.magnet && cup.x <= c.x + 8;
      if (!cup.taken && (touching || magnet)) {
        cup.taken = true;
        this.garlic++;
        this.heat = Math.max(0, this.heat - HEAT.garlicCool);
        this.burst(cup.x + 4, cup.y - 4, 8, [avocat, toum, toum], 60, 0, 0.45, 1);
        this.floatText(
          () => this.t.t("canvas.garlicPlus", { n: POINTS_PER_GARLIC }),
          cup.x + 4,
          cup.y - 12,
          avocat,
          10,
          0.6,
        );
        this.play("pick");
      }
    }
    this.cups = this.cups.filter((cup) => cup.x > -12 && !cup.taken);

    this.checkMilestones(this.points());
    if (this.heat >= HEAT.max) this.caught();
    this.updateHud();
  }

  /** The run's points so far: whole metres plus 10 per garlic (game-core/score.ts). */
  private points(): number {
    return pointsOf({ distanceM: pxToMetres(this.dist), garlic: this.garlic });
  }

  private hit(type: BaseObstacleType): void {
    const c = this.chick;
    this.heat += HEAT.hit;
    this.hits++;
    c.inv = HEAT.invulnerableS;
    this.shake = this.opts.reducedMotion ? 0 : 6;
    this.lastHit = { type, at: this.runTime };
    this.burst(c.x + 8, c.y - 8, 14, FEATHERS, 90, 120, 0.9, 2);
    const which = Math.floor(Math.random() * 4);
    this.floatText(
      () => this.t.list("canvas.hits")[which] ?? "!",
      c.x + 8,
      c.y - 24,
      toum,
      10,
      0.8,
    );
    this.play("hit");
  }

  /** Point milestones (GAME-05): 50, 100, 150, 200, then every 100 points. */
  private checkMilestones(points: number): void {
    const list = TUNING.milestonesPts;
    while (points >= this.nextMilestone) {
      const n = this.nextMilestone;
      const i = this.milestoneIdx++;
      this.nextMilestone =
        this.milestoneIdx < list.length
          ? list[this.milestoneIdx]
          : list[list.length - 1] +
            TUNING.milestoneEveryPts * (this.milestoneIdx - list.length + 1);
      this.opts.onEvent({ type: "milestone", points: n });
      this.floatText(() => this.milestoneText(n, i), W / 2, this.ground - 102, toum, 11, 1.6);
      this.play("mile");
    }
  }

  /** The i-th milestone's line: one each for the first few, then quips in turn. */
  private milestoneText(n: number, i: number): string {
    const first = TUNING.milestonesPts.length;
    const vars = { n: this.t.num(n) };
    if (i < first) return this.t.list("milestone.first", vars)[i] ?? `${n} PTS`;
    const quips = this.t.list("milestone.every", vars);
    return quips[(i - first) % quips.length] ?? `${n} PTS`;
  }

  private caught(): void {
    this.caughtT = 0;
    this.setState("caught");
    this.play("caught");
  }

  private stepCaught(dt: number): void {
    const c = this.chick;
    this.caughtT += dt;
    this.speed *= Math.pow(0.04, dt);
    const slide = this.speed * dt;
    this.viewDist += slide;
    for (const o of this.obstacles) o.x -= slide;
    for (const cup of this.cups) cup.x -= slide;
    if (this.caughtT > 0.35 && c.visible) {
      c.visible = false;
      this.shake = this.opts.reducedMotion ? 0 : 5;
      this.burst(c.x + 8, c.y - 8, 28, [...FEATHERS, tomate], 120, 140, 1.2, 2);
      this.burst(c.x + 8, c.y - 6, 10, [alpha(mix(toum, vert, 0.4), 0.7)], 30, -20, 0.8, 3);
      this.wrap = { x: c.x + 1, y: c.y - 30, vy: -80, b: 0 };
    }
    if (this.caughtT > 1.7) this.finish();
  }

  private finish(): void {
    const activeMs = Math.round(this.runTime * 1000);
    const recent = this.lastHit && this.runTime - this.lastHit.at < 2.5 ? this.lastHit.type : null;
    const distanceM = distanceMAt(activeMs);
    const result: RunResult = {
      seed: this.setup?.seed ?? 0,
      distanceM,
      garlic: this.garlic,
      hits: this.hits,
      activeMs,
      points: pointsOf({ distanceM, garlic: this.garlic }),
      cause: recent ?? "creep",
    };
    this.setState("over");
    this.opts.onEvent({ type: "over", result });
  }

  private updateHud(): void {
    const { hud } = this.opts;
    const cache = this.hudCache;
    const meter = Math.round((this.heat / HEAT.max) * 100);
    if (meter !== cache.meter) {
      cache.meter = meter;
      hud.meterFill.style.width = `${meter}%`;
    }
    const level = this.heat < 1.2 ? "low" : this.heat < 2.2 ? "mid" : "high";
    if (level !== cache.level) {
      cache.level = level;
      hud.spit.dataset.level = level;
    }
    const points = this.t.num(this.points());
    if (points !== cache.points) {
      cache.points = points;
      hud.points.textContent = points;
    }
    const garlic = this.t.num(this.garlic);
    if (garlic !== cache.garlic) {
      cache.garlic = garlic;
      hud.garlic.textContent = garlic;
    }
  }

  // ---------- render ----------

  /** Draws a backdrop strip at its logical size, repeated to fill the width. */
  private tile(l: Layer, off: number): void {
    const x = -Math.floor(off % l.w);
    for (let i = x > -BLEED ? x - l.w : x; i < W + BLEED; i += l.w) {
      this.ctx.drawImage(l.c, i, l.y, l.w, l.h);
    }
  }

  /** An étincelle (the brand's four-point star): arms `r` px long, a 3 x 3 core when r is 3. */
  private spark(x: number, y: number, r: number): void {
    const { ctx } = this;
    ctx.fillRect(x - r, y, 2 * r + 1, 1);
    ctx.fillRect(x, y - r, 1, 2 * r + 1);
    if (r > 2) ctx.fillRect(x - 1, y - 1, 3, 3);
  }

  private drawSky(): void {
    const { ctx, ground: g, T } = this;
    // Flat bands down to the ground line (the ground covers the rest), each drawn once.
    SKY.forEach((c, i) => {
      const y = i ? Math.round(g * SKY_CUTS[i]) : -BLEED;
      ctx.fillStyle = c;
      ctx.fillRect(
        -BLEED,
        y,
        W + 2 * BLEED,
        (SKY_CUTS[i + 1] ? Math.round(g * SKY_CUTS[i + 1]) : g) - y,
      );
    });
    ctx.drawImage(this.moon, W - 68, 20);
    for (const s of this.stars) {
      const a = Math.abs(Math.sin(T * s.sp + s.ph));
      ctx.globalAlpha = 0.35 + 0.65 * a;
      ctx.fillStyle = s.hot ? avocat : toum;
      this.spark(s.x, s.y, s.r === 3 && a < 0.45 ? 2 : s.r === 2 && a < 0.3 ? 1 : s.r);
    }
    ctx.globalAlpha = 1;
  }

  private drawGround(): void {
    const { ctx, ground: g, H } = this;
    const d = this.viewDist;
    const w = W + 2 * BLEED;
    ctx.fillStyle = SIDEWALK;
    ctx.fillRect(-BLEED, g, w, 14);
    ctx.fillStyle = mix(vert, toum, 0.26);
    ctx.fillRect(-BLEED, g, w, 1);
    ctx.fillStyle = mix(vert, toum, 0.08);
    const o = Math.floor(d % 22);
    for (let x = -o; x < W + BLEED; x += 22) ctx.fillRect(x, g + 1, 1, 13);
    ctx.fillStyle = toum;
    ctx.fillRect(-BLEED, g + 14, w, 2);
    ctx.fillStyle = ROAD;
    ctx.fillRect(-BLEED, g + 16, w, H - g - 16 + BLEED);
    ctx.fillStyle = toum;
    const o2 = Math.floor(d % 34);
    for (let x = -o2; x < W + BLEED; x += 34) ctx.fillRect(x, g + 22, 14, 2);
  }

  private drawObstacle(o: ActiveObstacle): void {
    const { ctx } = this;
    const x = Math.round(o.x);
    const y = Math.round(o.y);
    switch (o.spawn.type) {
      case "pickle": {
        // A jar of pickled turnips (Navet is named after them): Toum glass, Hummus lid.
        ctx.fillStyle = hummus;
        ctx.fillRect(x + 1, y - 17, 10, 3);
        ctx.fillStyle = toum;
        ctx.fillRect(x + 1, y - 17, 10, 1);
        ctx.fillRect(x, y - 14, 12, 14);
        ctx.fillStyle = navet;
        ctx.fillRect(x + 1, y - 12, 10, 11);
        ctx.fillStyle = mix(navet, toum, 0.45);
        ctx.fillRect(x + 2, y - 11, 3, 2);
        ctx.fillRect(x + 6, y - 8, 3, 2);
        ctx.fillRect(x + 3, y - 5, 3, 2);
        ctx.fillStyle = mix(navet, toum, 0.7);
        ctx.fillRect(x + 1, y - 13, 1, 11);
        break;
      }
      case "pita":
        for (let i = 0; i < 3; i++) {
          const yy = y - 3 - i * 3;
          ctx.fillStyle = mix(hummus, vert, 0.3);
          ctx.fillRect(x + 1, yy, 18, 3);
          ctx.fillStyle = hummus;
          ctx.fillRect(x + 2, yy, 16, 2);
          ctx.fillStyle = mix(hummus, toum, 0.6);
          ctx.fillRect(x + 4 + i * 2, yy, 6, 1);
          ctx.fillStyle = mix(hummus, vert, 0.5);
          ctx.fillRect(x + 12 - i, yy + 1, 1, 1);
        }
        break;
      case "sauce":
        ctx.fillStyle = laitue;
        ctx.fillRect(x + 2, y - 19, 3, 3);
        ctx.fillStyle = tomate;
        ctx.fillRect(x + 2, y - 16, 3, 3);
        ctx.fillRect(x, y - 13, 7, 13);
        ctx.fillStyle = toum;
        ctx.fillRect(x + 1, y - 9, 5, 4);
        ctx.fillStyle = tomate;
        ctx.fillRect(x + 3, y - 8, 1, 2);
        ctx.fillStyle = mix(tomate, toum, 0.45);
        ctx.fillRect(x + 1, y - 12, 1, 3);
        break;
      case "falafel":
        ctx.save();
        ctx.translate(x + 5, y - 5);
        ctx.rotate(o.rot);
        ctx.drawImage(this.sprites.falafel, -5, -5);
        ctx.restore();
        break;
      case "potato":
        // Tomate motion streak behind it: a hazard, not a pickup (GAME-11).
        ctx.fillStyle = tomate;
        ctx.fillRect(x + 9, y - 6, 5, 1);
        ctx.fillRect(x + 10, y - 3, 6, 1);
        ctx.drawImage(this.sprites.potato, x, y - 8);
        break;
    }
  }

  private drawCup(cup: ActiveGarlic): void {
    const { ctx, T } = this;
    const bob = Math.round(Math.sin(T * 5 + cup.ph) * 1.5);
    const x = Math.round(cup.x);
    const y = Math.round(cup.y) + bob;
    ctx.globalAlpha = 0.7 + 0.2 * Math.sin(T * 6 + cup.ph);
    ctx.drawImage(this.cupGlow, x - 8, y - 16, 24, 24);
    ctx.globalAlpha = 0.85;
    ctx.drawImage(this.plate, x - 3, y - 11);
    ctx.globalAlpha = 1;
    ctx.drawImage(this.sprites.cup, x, y - 8);
    // Étincelle twinkle: big, small, off.
    const twinkle = Math.floor(T * 4 + cup.ph) % 3;
    if (twinkle < 2) {
      ctx.fillStyle = toum;
      this.spark(x + 8, y - 9, twinkle === 0 ? 3 : 2);
    }
  }

  private wheel(wx: number, wy: number): void {
    const { ctx } = this;
    ctx.fillStyle = mix(vert, "#000000", 0.5);
    ctx.fillRect(wx - 3, wy - 3, 6, 6);
    ctx.fillRect(wx - 2, wy - 4, 4, 8);
    ctx.fillRect(wx - 4, wy - 2, 8, 4);
    const dx = Math.round(Math.cos(this.wheelRot) * 2);
    const dy = Math.round(Math.sin(this.wheelRot) * 2);
    ctx.fillStyle = METAL[2];
    ctx.fillRect(wx + dx, wy + dy, 1, 1);
    ctx.fillRect(wx - dx, wy - dy, 1, 1);
    ctx.fillStyle = METAL[0];
    ctx.fillRect(wx, wy, 1, 1);
  }

  private eye(ex: number, ey: number): void {
    const { ctx } = this;
    ctx.fillStyle = toum;
    ctx.fillRect(ex, ey, 5, 4);
    ctx.fillStyle = vert;
    ctx.fillRect(ex + 3, ey + 1, 2, 2);
  }

  private drawSpit(): void {
    const { ctx, T } = this;
    const over = this._state === "over";
    const frozen = over || this._state === "paused" || this._state === "countdown";
    const x = Math.round(this.spitX);
    const y = this.ground + (frozen ? 0 : Math.round(Math.sin(T * 22) * 0.7));
    ctx.drawImage(this.spitGlow, x - 32, y - 82, 96, 96);
    ctx.fillStyle = METAL[3];
    ctx.fillRect(x + 2, y - 11, 28, 5);
    ctx.fillStyle = METAL[2];
    ctx.fillRect(x + 2, y - 11, 28, 1);
    this.wheel(x + 8, y - 3);
    this.wheel(x + 24, y - 3);
    ctx.fillStyle = METAL[1];
    ctx.fillRect(x + 15, y - 68, 2, 58);
    ctx.fillStyle = mix(vert, "#000000", 0.4);
    ctx.fillRect(x - 1, y - 60, 2, 48);
    ctx.globalAlpha = 0.7 + Math.random() * 0.3;
    ctx.fillStyle = tomate;
    ctx.fillRect(x + 1, y - 58, 3, 44);
    ctx.fillStyle = poivron;
    ctx.fillRect(x + 2, y - 56 + (Math.floor(T * 40) % 40), 1, 3);
    ctx.globalAlpha = 1;
    const top = y - 60;
    ctx.drawImage(this.meat[Math.floor(T * 14) & 3], x + 3, top);
    ctx.fillStyle = tomate;
    ctx.fillRect(x + 11, top - 3, 10, 3);
    ctx.fillStyle = mix(tomate, toum, 0.3);
    ctx.fillRect(x + 12, top - 3, 8, 1);
    ctx.fillStyle = toum;
    ctx.fillRect(x + 13, top - 5, 6, 2);
    const ey = top + 12;
    this.eye(x + 8, ey);
    this.eye(x + 18, ey);
    ctx.fillStyle = vert;
    ctx.fillRect(x + 7, ey - 3, 3, 1);
    ctx.fillRect(x + 10, ey - 2, 3, 1);
    ctx.fillRect(x + 21, ey - 3, 3, 1);
    ctx.fillRect(x + 18, ey - 2, 3, 1);
    if (over) {
      ctx.fillRect(x + 11, ey + 6, 10, 1);
      ctx.fillRect(x + 10, ey + 5, 1, 1);
      ctx.fillRect(x + 21, ey + 5, 1, 1);
    } else {
      ctx.fillRect(x + 11, ey + 7, 10, 1);
      ctx.fillRect(x + 10, ey + 6, 1, 1);
      ctx.fillRect(x + 21, ey + 6, 1, 1);
      ctx.fillStyle = toum;
      ctx.fillRect(x + 12, ey + 6, 1, 1);
      ctx.fillRect(x + 19, ey + 6, 1, 1);
    }
  }

  private drawChicken(): void {
    const { ctx, chick: c, ground: g, T } = this;
    if (!c.visible) return;
    const hgt = g - c.y;
    const sw = Math.max(4, Math.round(12 - hgt / 6));
    ctx.fillStyle = SHADOW;
    ctx.fillRect(Math.round(c.x + 8 - sw / 2), g + 1, sw, 2);
    if (c.inv > 0 && Math.floor(c.inv * 16) % 2 === 0) return;
    const fr = !c.onGround
      ? this.sprites.jump
      : Math.floor(c.anim) % 2
        ? this.sprites.run2
        : this.sprites.run1;
    const x = Math.round(c.x);
    const y = Math.round(c.y) - 16;
    ctx.drawImage(fr, x, y);
    if ((this._state === "title" || this.heat > 1.4) && Math.floor(T * 6) % 2 === 0) {
      ctx.fillStyle = toum;
      ctx.fillRect(x + 7, y + 1, 1, 2);
      ctx.fillRect(x + 6, y + 2, 1, 1);
    }
  }

  /**
   * Text in the brand's condensed face (or the display serif), shrunk until it fits `maxW`, with
   * a hard 1 px Vert offset for legibility: the guide has no blurred shadows. Callers set
   * textAlign and textBaseline; the position snaps to device pixels so it stays crisp.
   */
  private text(
    str: string,
    x: number,
    y: number,
    size: number,
    color: string,
    maxW = W - 8,
    display = false,
  ): void {
    const { ctx, k } = this;
    const { fonts } = this.opts;
    const font = (s: number) =>
      display ? `400 ${s}px ${fonts.display}` : `600 ${s}px ${fonts.condensed}`;
    ctx.font = font(size);
    const w = ctx.measureText(str).width;
    if (w > maxW) ctx.font = font(Math.max(5, Math.floor((size * maxW) / w)));
    const px = Math.round(x * k) / k;
    const py = Math.round(y * k) / k;
    ctx.fillStyle = vert;
    ctx.fillText(str, px + 1, py + 1);
    ctx.fillStyle = color;
    ctx.fillText(str, px, py);
  }

  private render(): void {
    const { ctx, H, k } = this;
    const bd = this.backdrop;
    // Resizing the canvas resets the context, so start every frame from known state.
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.save();
    if (this.shake > 0) {
      ctx.translate(Math.round(rand(-1, 1) * this.shake), Math.round(rand(-1, 1) * this.shake));
    }
    this.drawSky();
    this.tile(bd.mount, this.viewDist * 0.03);
    this.tile(bd.skyline, this.viewDist * 0.15);
    if (bd.shops) this.tile(bd.shops, this.viewDist * 0.45);
    this.drawGround();
    for (const cup of this.cups) this.drawCup(cup);
    for (const o of this.obstacles) this.drawObstacle(o);
    this.drawChicken();
    if (this.wrap)
      this.ctx.drawImage(this.sprites.wrap, Math.round(this.wrap.x), Math.round(this.wrap.y) - 9);
    this.drawSpit();
    for (const p of this.parts) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.c;
      ctx.fillRect(Math.round(p.x), Math.round(p.y), p.s, p.s === 2 && p.g > 0 ? 1 : p.s);
    }
    ctx.globalAlpha = 1;
    const state = this._state;
    const hot = Math.min(1, this.heat / HEAT.max);
    if (hot > 0.03 && state !== "title" && state !== "over") {
      ctx.globalAlpha = hot;
      VIGNETTE.forEach((c, i) => {
        ctx.fillStyle = c;
        ctx.fillRect(i ? i * VIGNETTE_BAND : -BLEED, 0, VIGNETTE_BAND + (i ? 0 : BLEED), H);
      });
      ctx.globalAlpha = 1;
    }
    if (this.fontReady) {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const t of this.texts) {
        ctx.globalAlpha = Math.min(1, (t.life / t.max) * 2);
        this.text(t.text(), t.x, t.y, t.size, t.color);
      }
      ctx.globalAlpha = 1;
    }
    if (state === "paused" || state === "countdown") {
      ctx.fillStyle = DIM;
      ctx.fillRect(-BLEED, -BLEED, W + 2 * BLEED, H + 2 * BLEED);
      if (state === "countdown" && this.fontReady) {
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        this.text(
          String(Math.ceil(this.countdown)),
          W / 2,
          Math.round(H * 0.42),
          44,
          avocat,
          W,
          true,
        );
      }
    }
    ctx.restore();
  }
}
