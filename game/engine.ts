/**
 * The runner, ported from the reference prototype (PRD §4.1) onto game-core.
 *
 * What changed from the reference:
 * - Obstacles and garlic come from the seeded level (GAME-06). Their positions are functions of
 *   active run time, so they don't depend on frame rate.
 * - Distance comes from the speed curve (SEC-02); score is distance, garlic and hits.
 * - Rewards unlock mid-run with a banner (GAME-02); milestones are by distance (GAME-05).
 * - Pause with a 3-2-1 countdown on resume (GAME-09). Paused time isn't counted.
 * - Canvas text comes from the i18n dictionaries and follows language switches mid-run.
 */
import {
  REWARD_IDS,
  TUNING,
  createLevel,
  distanceMAt,
  distancePxAt,
  meetsRule,
  pxToMetres,
  speedAt,
  timeAtDistancePx,
  type BaseObstacleType,
  type GarlicSpawn,
  type Level,
  type ObstacleSpawn,
  type RewardId,
  type RewardRules,
} from "@/game-core";
import type { Translator } from "@/i18n";
import { Sfx, type Sound } from "./audio";
import {
  BRAND,
  buildBackdrop,
  buildShops,
  buildSprites,
  glowSprite,
  heatSprite,
  type Backdrop,
  type Sprites,
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
  unlocked: RewardId[];
  cause: DeathCause;
}

export interface RunSetup {
  seed: number;
  rules: RewardRules;
  /** Whether each reward can be claimed in this run (campaign open, in stock, online). */
  claimable: Record<RewardId, boolean>;
}

export type GameEvent =
  /** The first frame is on screen: the game can be played. */
  | { type: "ready" }
  | { type: "state"; state: GameState }
  | { type: "milestone"; m: number }
  | { type: "unlock"; reward: RewardId; claimable: boolean; text: string }
  | { type: "over"; result: RunResult };

export interface HudRefs {
  /** Spit meter group; gets data-level="low|mid|high". */
  spit: HTMLElement;
  meterFill: HTMLElement;
  distance: HTMLElement;
  distanceValue: HTMLElement;
  distanceBar: HTMLElement;
  garlic: HTMLElement;
  garlicValue: HTMLElement;
}

export interface GameOptions {
  canvas: HTMLCanvasElement;
  /** Element that takes taps (canvas plus HUD). */
  frame: HTMLElement;
  hud: HudRefs;
  /** CSS font-family list of the pixel font. */
  font: string;
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
interface Banner {
  reward: RewardId;
  text: () => string;
  life: number;
  max: number;
}

const { view, physics, heat: HEAT, obstacles: OB, speed: SPEED } = TUNING;
const W = view.width;
const BANNER_S = 1.5;
const COUNTDOWN_S = 3;
const CONFETTI = [BRAND.red, BRAND.cream, "#ffc93c", "#4cd07d", "#ffffff"];
const MEAT = ["#8b4a1c", "#a85a22", "#c46f2c", "#7a3d15"];

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
  private readonly cupGlow = glowSprite(10, "255,220,120", 1);
  private readonly spitGlow = glowSprite(48, "255,120,30", 0.32);
  private t: Translator;
  private H = 0;
  private ground = 0;
  private backdrop!: Backdrop;
  private heatFx!: HTMLCanvasElement;
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
  private banners: Banner[] = [];
  private unlocked = new Set<RewardId>();
  private milestoneIdx = 0;
  private nextMilestone: number = TUNING.milestonesM[0];
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
  private hudCache = {
    meter: -1,
    level: "",
    dist: "",
    distDone: "",
    bar: -1,
    garlic: "",
    garlicDone: "",
  };

  constructor(opts: GameOptions) {
    this.opts = opts;
    this.t = opts.translator;
    const ctx = opts.canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
    this.sfx = new Sfx(opts.muted);
    this.sprites = buildSprites();
    this.layout(opts.portrait);
    opts.frame.dataset.running = "false";

    opts.frame.addEventListener("pointerdown", this.onPointerDown, { passive: false });
    window.addEventListener("keydown", this.onKeyDown);
    const loadFont = document.fonts?.load(`8px ${opts.font}`);
    const ready = () => this.onFontReady();
    if (loadFont) loadFont.then(ready, ready);
    else ready();
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
    this.banners = [];
    this.unlocked = new Set();
    this.milestoneIdx = 0;
    this.nextMilestone = TUNING.milestonesM[0];
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
    this.hudCache.dist = "";
    this.setState("play");
    this.floatText(() => this.t.t("canvas.run"), W / 2, this.ground - 80, "#ffc93c", 16, 1);
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
      this.burst(c.x + 4, c.y - 6, 5, ["#fff7e6", "#d8ccb6"], 40, 50, 0.6, 1);
    }
  }

  setTranslator(t: Translator): void {
    this.t = t;
    this.hudCache.dist = "";
    this.hudCache.garlic = "";
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
      unlocked: [...this.unlocked],
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
    const { canvas } = this.opts;
    canvas.width = W;
    canvas.height = this.H;
    this.ctx.imageSmoothingEnabled = false;
    this.backdrop = buildBackdrop(W, this.H, this.ground);
    this.heatFx = heatSprite(this.H);
    this.chick.y = this.ground;
    if (this.fontReady) this.backdrop.shops = buildShops(this.H, this.ground, this.opts.font);
  }

  private onFontReady(): void {
    if (this.fontReady || this.destroyed) return;
    this.fontReady = true;
    this.backdrop.shops = buildShops(this.H, this.ground, this.opts.font);
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
    this.burst(x, y - 1, n, ["#6b5c96", "#4a3d73"], 30, -10, 0.4, 2);
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
    const dt = Math.min(physics.maxFrameS, Math.max(0, (now - this.last) / 1000));
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
    if (this.banners.length > 0) {
      this.banners[0].life -= dt;
      if (this.banners[0].life <= 0) this.banners.shift();
    }
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
            c: "rgba(255,255,255,.6)",
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
        this.burst(cup.x + 4, cup.y - 4, 8, ["#ffc93c", "#fff7e6", "#fff3c4"], 60, 0, 0.45, 1);
        this.floatText(
          () => this.t.t("canvas.garlicPlus"),
          cup.x + 4,
          cup.y - 12,
          "#fff3c4",
          8,
          0.6,
        );
        this.play("pick");
      }
    }
    this.cups = this.cups.filter((cup) => cup.x > -12 && !cup.taken);

    const distanceM = pxToMetres(this.dist);
    const unlockedNow = this.checkUnlocks(distanceM);
    this.checkMilestones(distanceM, unlockedNow);
    if (this.heat >= HEAT.max) this.caught();
    this.updateHud();
  }

  private hit(type: BaseObstacleType): void {
    const c = this.chick;
    this.heat += HEAT.hit;
    this.hits++;
    c.inv = HEAT.invulnerableS;
    this.shake = this.opts.reducedMotion ? 0 : 6;
    this.lastHit = { type, at: this.runTime };
    this.burst(c.x + 8, c.y - 8, 14, ["#fff7e6", "#d8ccb6", "#ffffff"], 90, 120, 0.9, 2);
    const which = Math.floor(Math.random() * 4);
    this.floatText(
      () => this.t.list("canvas.hits")[which] ?? "!",
      c.x + 8,
      c.y - 24,
      "#ff5c8a",
      8,
      0.8,
    );
    this.play("hit");
  }

  /** Unlocks each reward at most once per run (GAME-02). Returns rewards unlocked this frame. */
  private checkUnlocks(distanceM: number): RewardId[] {
    const setup = this.setup;
    if (!setup) return [];
    const now: RewardId[] = [];
    for (const id of REWARD_IDS) {
      if (this.unlocked.has(id) || !meetsRule(id, { distanceM, garlic: this.garlic }, setup.rules))
        continue;
      this.unlocked.add(id);
      now.push(id);
      const claimable = setup.claimable[id];
      const text = () => this.unlockText(id, claimable);
      this.banners.push({ reward: id, text, life: BANNER_S, max: BANNER_S });
      const c = this.chick;
      if (!this.opts.reducedMotion) this.burst(c.x + 8, c.y - 10, 26, CONFETTI, 110, 140, 1.2, 2);
      this.play("unlock");
      this.opts.onEvent({ type: "unlock", reward: id, claimable, text: text() });
    }
    return now;
  }

  private unlockText(id: RewardId, claimable: boolean): string {
    const rules = this.setup?.rules ?? TUNING.rewards;
    if (id === "free_coke") {
      return claimable
        ? this.t.t("unlock.coke")
        : this.t.t("unlock.distance", { m: rules.free_coke.distanceM });
    }
    return claimable
      ? this.t.t("unlock.garlic")
      : this.t.t("unlock.garlicCount", { n: rules.free_garlic_sauce.garlic });
  }

  /** Distance milestones (GAME-05): 25, 50, 75, 100, then every 100 m. */
  private checkMilestones(distanceM: number, unlockedNow: RewardId[]): void {
    while (distanceM >= this.nextMilestone) {
      const m = this.nextMilestone;
      const list = TUNING.milestonesM;
      this.milestoneIdx++;
      this.nextMilestone =
        this.milestoneIdx < list.length
          ? list[this.milestoneIdx]
          : list[list.length - 1] + TUNING.milestoneEveryM * (this.milestoneIdx - list.length + 1);
      this.opts.onEvent({ type: "milestone", m });
      const cokeAt = this.setup?.rules.free_coke.distanceM;
      if (m === cokeAt && unlockedNow.includes("free_coke")) continue; // the banner says it
      const idx = this.milestoneIdx;
      this.floatText(() => this.milestoneText(m, idx), W / 2, this.ground - 102, "#4cd07d", 8, 1.6);
      this.play("mile");
    }
  }

  private milestoneText(m: number, idx: number): string {
    switch (m) {
      case 25:
        return this.t.t("milestone.m25");
      case 50:
        return this.setup?.claimable.free_coke && this.setup.rules.free_coke.distanceM === 100
          ? this.t.t("milestone.m50")
          : this.t.t("milestone.m50NoReward");
      case 75:
        return this.t.t("milestone.m75");
      case 100:
        return this.t.t("milestone.m100");
      default: {
        const quips = this.t.list("milestone.every", { m: this.t.num(m) });
        return quips[idx % quips.length] ?? `${m} M`;
      }
    }
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
      this.burst(
        c.x + 8,
        c.y - 8,
        28,
        ["#fff7e6", "#d8ccb6", "#ffffff", "#ff3b3b"],
        120,
        140,
        1.2,
        2,
      );
      this.burst(c.x + 8, c.y - 6, 10, ["rgba(200,190,220,.7)"], 30, -20, 0.8, 3);
      this.wrap = { x: c.x + 1, y: c.y - 30, vy: -80, b: 0 };
    }
    if (this.caughtT > 1.7) this.finish();
  }

  private finish(): void {
    const activeMs = Math.round(this.runTime * 1000);
    const recent = this.lastHit && this.runTime - this.lastHit.at < 2.5 ? this.lastHit.type : null;
    const result: RunResult = {
      seed: this.setup?.seed ?? 0,
      distanceM: distanceMAt(activeMs),
      garlic: this.garlic,
      hits: this.hits,
      activeMs,
      unlocked: REWARD_IDS.filter((id) => this.unlocked.has(id)),
      cause: recent ?? "creep",
    };
    this.setState("over");
    this.opts.onEvent({ type: "over", result });
  }

  private updateHud(): void {
    const { hud } = this.opts;
    const cache = this.hudCache;
    const rules = this.setup?.rules ?? TUNING.rewards;
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
    const distanceM = pxToMetres(this.dist);
    const goalM = rules.free_coke.distanceM;
    const dist = `${this.t.num(distanceM)} m`;
    if (dist !== cache.dist) {
      cache.dist = dist;
      hud.distanceValue.textContent = dist;
    }
    const distDone = String(distanceM >= goalM);
    if (distDone !== cache.distDone) {
      cache.distDone = distDone;
      hud.distance.dataset.done = distDone;
    }
    const bar = Math.min(100, Math.floor((distanceM / goalM) * 100));
    if (bar !== cache.bar) {
      cache.bar = bar;
      hud.distanceBar.style.width = `${bar}%`;
    }
    const goal = rules.free_garlic_sauce.garlic;
    const garlicDone = String(this.garlic >= goal);
    const garlic = this.garlic >= goal ? this.t.num(this.garlic) : `${this.garlic}/${goal}`;
    if (garlic !== cache.garlic) {
      cache.garlic = garlic;
      hud.garlicValue.textContent = garlic;
    }
    if (garlicDone !== cache.garlicDone) {
      cache.garlicDone = garlicDone;
      hud.garlic.dataset.done = garlicDone;
    }
  }

  // ---------- render ----------

  private tile(c: HTMLCanvasElement, off: number): void {
    const w = c.width;
    const x = -Math.floor(off % w);
    this.ctx.drawImage(c, x, 0);
    if (x + w < W) this.ctx.drawImage(c, x + w, 0);
  }

  private drawGround(): void {
    const { ctx, ground: g, H } = this;
    const d = this.viewDist;
    ctx.fillStyle = "#2b2342";
    ctx.fillRect(0, g, W, 14);
    ctx.fillStyle = "#4a3d73";
    ctx.fillRect(0, g, W, 1);
    ctx.fillStyle = "#3a2f5c";
    const o = Math.floor(d % 22);
    for (let x = -o; x < W; x += 22) ctx.fillRect(x, g + 1, 1, 13);
    ctx.fillStyle = "#5b4c8a";
    ctx.fillRect(0, g + 14, W, 2);
    ctx.fillStyle = "#15112a";
    ctx.fillRect(0, g + 16, W, H - g - 16);
    ctx.fillStyle = "#ffc93c";
    const o2 = Math.floor(d % 34);
    for (let x = -o2; x < W; x += 34) ctx.fillRect(x, g + 22, 14, 2);
  }

  private drawObstacle(o: ActiveObstacle): void {
    const { ctx } = this;
    const x = Math.round(o.x);
    const y = Math.round(o.y);
    switch (o.spawn.type) {
      case "pickle":
        ctx.fillStyle = "#c9a227";
        ctx.fillRect(x + 1, y - 17, 10, 3);
        ctx.fillStyle = "#ecd060";
        ctx.fillRect(x + 1, y - 17, 10, 1);
        ctx.fillStyle = "#bfe6ee";
        ctx.fillRect(x, y - 14, 12, 14);
        ctx.fillStyle = "#ff5c8a";
        ctx.fillRect(x + 1, y - 12, 10, 11);
        ctx.fillStyle = "#ffa3c0";
        ctx.fillRect(x + 2, y - 11, 3, 2);
        ctx.fillRect(x + 6, y - 8, 3, 2);
        ctx.fillRect(x + 3, y - 5, 3, 2);
        ctx.fillStyle = "rgba(255,255,255,.6)";
        ctx.fillRect(x + 1, y - 13, 1, 11);
        break;
      case "pita":
        for (let i = 0; i < 3; i++) {
          const yy = y - 3 - i * 3;
          ctx.fillStyle = "#c98f45";
          ctx.fillRect(x + 1, yy, 18, 3);
          ctx.fillStyle = "#ecc27e";
          ctx.fillRect(x + 2, yy, 16, 2);
          ctx.fillStyle = "#f7dca8";
          ctx.fillRect(x + 4 + i * 2, yy, 6, 1);
          ctx.fillStyle = "#a8702f";
          ctx.fillRect(x + 12 - i, yy + 1, 1, 1);
        }
        break;
      case "sauce":
        ctx.fillStyle = "#2d9b55";
        ctx.fillRect(x + 2, y - 19, 3, 3);
        ctx.fillStyle = "#e2231a";
        ctx.fillRect(x + 2, y - 16, 3, 3);
        ctx.fillRect(x, y - 13, 7, 13);
        ctx.fillStyle = "#fff7e6";
        ctx.fillRect(x + 1, y - 9, 5, 4);
        ctx.fillStyle = "#e2231a";
        ctx.fillRect(x + 3, y - 8, 1, 2);
        ctx.fillStyle = "rgba(255,255,255,.45)";
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
        // Red motion streak behind it: a hazard, not a pickup (GAME-11).
        ctx.fillStyle = "rgba(255,59,59,.55)";
        ctx.fillRect(x + 9, y - 6, 4, 1);
        ctx.fillRect(x + 10, y - 3, 5, 1);
        ctx.drawImage(this.sprites.potato, x, y - 8);
        break;
    }
  }

  private drawCup(cup: ActiveGarlic): void {
    const { ctx, T } = this;
    const bob = Math.round(Math.sin(T * 5 + cup.ph) * 1.5);
    const x = Math.round(cup.x);
    const y = Math.round(cup.y) + bob;
    ctx.globalAlpha = 0.33 + 0.12 * Math.sin(T * 6 + cup.ph);
    ctx.drawImage(this.cupGlow, x - 6, y - 14);
    ctx.globalAlpha = 1;
    ctx.drawImage(this.sprites.cup, x, y - 8);
    if (Math.floor(T * 4 + cup.ph) % 3 === 0) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(x + 7, y - 10, 1, 1);
    }
  }

  private wheel(wx: number, wy: number): void {
    const { ctx } = this;
    ctx.fillStyle = "#1d1e24";
    ctx.fillRect(wx - 3, wy - 3, 6, 6);
    ctx.fillRect(wx - 2, wy - 4, 4, 8);
    ctx.fillRect(wx - 4, wy - 2, 8, 4);
    const dx = Math.round(Math.cos(this.wheelRot) * 2);
    const dy = Math.round(Math.sin(this.wheelRot) * 2);
    ctx.fillStyle = "#8a8f9c";
    ctx.fillRect(wx + dx, wy + dy, 1, 1);
    ctx.fillRect(wx - dx, wy - dy, 1, 1);
    ctx.fillStyle = "#c9ced8";
    ctx.fillRect(wx, wy, 1, 1);
  }

  private eye(ex: number, ey: number): void {
    const { ctx } = this;
    ctx.fillStyle = "#fff7e6";
    ctx.fillRect(ex, ey, 5, 4);
    ctx.fillStyle = "#1a1020";
    ctx.fillRect(ex + 3, ey + 1, 2, 2);
  }

  private drawSpit(): void {
    const { ctx, T } = this;
    const over = this._state === "over";
    const frozen = over || this._state === "paused" || this._state === "countdown";
    const x = Math.round(this.spitX);
    const y = this.ground + (frozen ? 0 : Math.round(Math.sin(T * 22) * 0.7));
    ctx.drawImage(this.spitGlow, x - 32, y - 82);
    ctx.fillStyle = "#4b4f5c";
    ctx.fillRect(x + 2, y - 11, 28, 5);
    ctx.fillStyle = "#6b7080";
    ctx.fillRect(x + 2, y - 11, 28, 1);
    this.wheel(x + 8, y - 3);
    this.wheel(x + 24, y - 3);
    ctx.fillStyle = "#a7adb8";
    ctx.fillRect(x + 15, y - 68, 2, 58);
    ctx.fillStyle = "#2b2d35";
    ctx.fillRect(x - 1, y - 60, 2, 48);
    ctx.globalAlpha = 0.7 + Math.random() * 0.3;
    ctx.fillStyle = "#ff5a1a";
    ctx.fillRect(x + 1, y - 58, 3, 44);
    ctx.fillStyle = "#ffb02e";
    ctx.fillRect(x + 2, y - 56 + (Math.floor(T * 40) % 40), 1, 3);
    ctx.globalAlpha = 1;
    const top = y - 60;
    const rows = 46;
    for (let r = 0; r < rows; r++) {
      const w = Math.round(26 - (r / (rows - 1)) * 12);
      const lx = x + 16 - (w >> 1);
      ctx.fillStyle = MEAT[(Math.floor(r / 2) + Math.floor(T * 14)) & 3];
      ctx.fillRect(lx, top + r, w, 1);
      ctx.fillStyle = "rgba(0,0,0,0.3)";
      ctx.fillRect(lx, top + r, Math.ceil(w * 0.22), 1);
      ctx.fillStyle = "rgba(255,210,140,0.22)";
      ctx.fillRect(lx + Math.floor(w * 0.58), top + r, Math.ceil(w * 0.14), 1);
    }
    ctx.fillStyle = "#e8352b";
    ctx.fillRect(x + 11, top - 3, 10, 3);
    ctx.fillStyle = "#ff6b5a";
    ctx.fillRect(x + 12, top - 3, 8, 1);
    ctx.fillStyle = "#f3e6c8";
    ctx.fillRect(x + 13, top - 5, 6, 2);
    const ey = top + 12;
    this.eye(x + 8, ey);
    this.eye(x + 18, ey);
    ctx.fillStyle = "#2a1208";
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
      ctx.fillStyle = "#fff7e6";
      ctx.fillRect(x + 12, ey + 6, 1, 1);
      ctx.fillRect(x + 19, ey + 6, 1, 1);
    }
  }

  private drawChicken(): void {
    const { ctx, chick: c, ground: g, T } = this;
    if (!c.visible) return;
    const hgt = g - c.y;
    const sw = Math.max(4, Math.round(12 - hgt / 6));
    ctx.fillStyle = "rgba(0,0,0,.35)";
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
      ctx.fillStyle = "#7fd4ff";
      ctx.fillRect(x + 7, y + 1, 1, 2);
      ctx.fillRect(x + 6, y + 2, 1, 1);
    }
  }

  /** Pixel text with a 1 px shadow, shrunk until it fits `maxW`. */
  private text(str: string, x: number, y: number, size: number, color: string, maxW = W - 8): void {
    const { ctx } = this;
    let s = size;
    ctx.font = `${s}px ${this.opts.font}`;
    while (s > 5 && ctx.measureText(str).width > maxW) {
      s--;
      ctx.font = `${s}px ${this.opts.font}`;
    }
    ctx.fillStyle = "#000";
    ctx.fillText(str, Math.round(x) + 1, Math.round(y) + 1);
    ctx.fillStyle = color;
    ctx.fillText(str, Math.round(x), Math.round(y));
  }

  private drawBanner(): void {
    const b = this.banners[0];
    if (!b || !this.fontReady) return;
    const { ctx } = this;
    const reduced = this.opts.reducedMotion;
    const age = b.max - b.life;
    const enter = reduced ? 1 : Math.min(1, age / 0.18);
    const offset = Math.round((1 - enter) ** 3 * W); // ease-out slide from the right
    const cy = Math.round(this.H * 0.3);
    const h = 24;
    ctx.globalAlpha = Math.min(1, b.life / 0.25);
    ctx.fillStyle = "#000";
    ctx.fillRect(offset, cy - h / 2 - 2, W, h + 4);
    ctx.fillStyle = BRAND.red;
    ctx.fillRect(offset, cy - h / 2, W, h);
    ctx.fillStyle = BRAND.cream;
    ctx.fillRect(offset, cy - h / 2 + 2, W, 1);
    ctx.fillRect(offset, cy + h / 2 - 3, W, 1);
    const icon = b.reward === "free_coke" ? this.sprites.can : this.sprites.cup;
    ctx.drawImage(icon, offset + 8, cy - (icon.height >> 1));
    ctx.drawImage(icon, offset + W - 8 - icon.width, cy - (icon.height >> 1));
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    this.text(b.text(), offset + W / 2, cy + 1, 8, "#ffffff", W - 44);
    ctx.globalAlpha = 1;
  }

  private render(): void {
    const { ctx, H, T } = this;
    const bd = this.backdrop;
    ctx.save();
    if (this.shake > 0) {
      ctx.translate(Math.round(rand(-1, 1) * this.shake), Math.round(rand(-1, 1) * this.shake));
    }
    ctx.drawImage(bd.sky, 0, 0);
    ctx.fillStyle = "#fff7e6";
    for (const s of bd.stars) {
      ctx.globalAlpha = 0.35 + 0.65 * Math.abs(Math.sin(T * s.sp + s.ph));
      ctx.fillRect(s.x, s.y, 1, 1);
    }
    ctx.globalAlpha = 1;
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
    if (state !== "title" && state !== "over") {
      ctx.globalAlpha = Math.min(1, this.heat / HEAT.max);
      ctx.drawImage(this.heatFx, 0, 0);
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
    this.drawBanner();
    if (state === "paused" || state === "countdown") {
      ctx.fillStyle = "rgba(8,6,20,.55)";
      ctx.fillRect(0, 0, W, H);
      if (state === "countdown" && this.fontReady) {
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        this.text(String(Math.ceil(this.countdown)), W / 2, Math.round(H * 0.42), 24, "#ffc93c");
      }
    }
    ctx.restore();
  }
}
