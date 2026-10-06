import { expect, type Frame, type Page } from "@playwright/test";

/** window.__stc as the game exposes it outside production. */
export interface Stc {
  start(): Promise<void>;
  jump(): void;
  pause(): void;
  resume(): void;
  state(): string;
  setHeat(h: number): void;
  snapshot(): {
    state: string;
    runTime: number;
    activeMs: number;
    distanceM: number;
    garlic: number;
    hits: number;
    heat: number;
    unlocked: string[];
  };
  cheat(c: { invincible?: boolean; magnet?: boolean }): void;
  levelDigest(seed: number, m: number): string;
}

type Target = Page | Frame;

export async function stcReady(target: Target): Promise<void> {
  await target.waitForFunction(() => "__stc" in window, null, { polling: 100 });
}

export function snapshot(target: Target) {
  return target.evaluate(() => (window as unknown as { __stc: Stc }).__stc.snapshot());
}

export function cheat(target: Target, c: { invincible?: boolean; magnet?: boolean }) {
  return target.evaluate((c) => (window as unknown as { __stc: Stc }).__stc.cheat(c), c);
}

export function setHeat(target: Target, h: number) {
  return target.evaluate((h) => (window as unknown as { __stc: Stc }).__stc.setHeat(h), h);
}

/**
 * Game time runs on Playwright's fake clock, so a 25-second run takes a moment and the mock
 * API's real-time check (activeMs ≤ time since the token was issued) still holds.
 */
export async function advance(page: Page, ms: number): Promise<void> {
  await page.clock.runFor(ms);
}

/** Taps PLAY and lets the mock API answer. */
export async function play(page: Page, target: Target = page): Promise<void> {
  const button = target.getByTestId("play");
  await expect(button).toBeEnabled();
  await button.click();
  await advance(page, 400);
  await expect.poll(async () => (await snapshot(target)).state).toBe("play");
}

/**
 * Runs `seconds` of game time in fixed 60 fps steps inside the page (one render at the end),
 * then moves the fake clock on by the same amount so wall time keeps up with game time. Much
 * faster than rendering every frame, which matters in WebKit.
 */
export async function simulate(page: Page, target: Target, seconds: number): Promise<void> {
  await target.evaluate(
    (s) => (window as unknown as { __stc: { run(s: number): void } }).__stc.run(s),
    seconds,
  );
  await page.clock.fastForward(Math.round(seconds * 1000));
  await advance(page, 100);
}

/** Plays with cheats until both rewards unlock, then lets the spit win. */
export async function unlockBothAndDie(page: Page, target: Target = page): Promise<void> {
  await cheat(target, { invincible: true, magnet: true });
  await simulate(page, target, 30);
  const snap = await snapshot(target);
  expect(snap.unlocked.sort()).toEqual(["free_coke", "free_garlic_sauce"]);
  await die(page, target);
}

export async function die(page: Page, target: Target = page): Promise<void> {
  await cheat(target, { invincible: false, magnet: false });
  await setHeat(target, 3);
  await simulate(page, target, 2.5);
  await expect.poll(async () => (await snapshot(target)).state).toBe("over");
  await advance(page, 500);
}

/** Collects console errors, ignoring the dev overlay's noise. */
export function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}
