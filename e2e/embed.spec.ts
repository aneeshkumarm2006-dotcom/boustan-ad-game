import { expect, test, type Page } from "@playwright/test";
import { advance, cheat, die, play, saveScore, scoreAndDie, snapshot, stcReady } from "./helpers";

const HOST = "http://127.0.0.1:3200";
const BLOCKED_HOST = "http://127.0.0.1:3201";

interface Pushed {
  event: string;
  boustan_game: Record<string, unknown>;
}

const dataLayer = (page: Page) =>
  page.evaluate(() => (window as unknown as { dataLayer: Pushed[] }).dataLayer ?? []);

async function gameFrame(page: Page) {
  const handle = await page.locator("iframe").elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error("no game frame");
  return frame;
}

test.beforeEach(async ({ page }) => {
  await page.clock.install();
});

test("plays in a cross-origin iframe; host events fire in order with no personal data (AC-13)", async ({
  page,
}) => {
  await page.goto(`${HOST}/?lang=fr&src=e2e-host`);
  const frame = await gameFrame(page);
  await stcReady(frame);
  await expect
    .poll(async () => (await dataLayer(page)).map((e) => e.event))
    .toContain("boustan_game_ready");

  await play(page, frame);
  await scoreAndDie(page, frame);
  await saveScore(page, frame, "hote@example.com");
  await expect(frame.getByRole("heading", { name: "Vous êtes au classement" })).toBeVisible();

  const pushed = await dataLayer(page);
  const events = pushed.map((e) => e.event);
  const order = [
    "boustan_game_ready",
    "boustan_game_game_start",
    "boustan_game_milestone",
    "boustan_game_game_over",
    "boustan_game_save_view",
    "boustan_game_score_saved",
  ];
  const positions = order.map((name) => events.indexOf(name));
  expect(positions.every((p) => p >= 0)).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  expect(events).not.toContain("boustan_game_resize"); // resizes aren't pushed to dataLayer

  expect(JSON.stringify(pushed)).not.toContain("@");
  // Milestones are by points: 50, 100, 150, 200, then every 100.
  const milestones = pushed.filter((e) => e.event === "boustan_game_milestone");
  expect(milestones.slice(0, 4).map((e) => e.boustan_game.points)).toEqual([50, 100, 150, 200]);
  const over = pushed.find((e) => e.event === "boustan_game_game_over")?.boustan_game;
  expect(Object.keys(over ?? {}).sort()).toEqual(["distance", "garlic", "points"]);
  expect(over?.points).toBe(Number(over?.distance) + 10 * Number(over?.garlic));
  const saved = pushed.find((e) => e.event === "boustan_game_score_saved");
  expect(saved?.boustan_game).toEqual({ rank: expect.any(Number) });
});

test("embed.js sizes the iframe from the game's resize events (EMB-04)", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 900 });
  await page.goto(`${HOST}/?lang=en&width=400`);
  const frame = await gameFrame(page);
  await stcReady(frame);
  const iframe = page.locator("iframe");
  await expect(iframe).toHaveAttribute("allow", /web-share/);
  // Initial guess is 1.3 × width; the game then asks for what it needs.
  await expect
    .poll(async () => (await iframe.boundingBox())?.height)
    .not.toBe(Math.round(400 * 1.3));
  const box = await iframe.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(400);
  // The whole stage fits without scrolling inside the frame.
  const fits = await frame.evaluate(
    () => document.documentElement.scrollHeight <= window.innerHeight + 1,
  );
  expect(fits).toBe(true);
});

test("host commands from an allowed origin work (EMB-05)", async ({ page }) => {
  await page.goto(`${HOST}/?lang=fr`);
  const frame = await gameFrame(page);
  await stcReady(frame);
  await page.getByRole("button", { name: "setLanguage en" }).click();
  await expect(frame.locator("html")).toHaveAttribute("lang", "en");
  await expect(frame.getByTestId("play")).toHaveText("RUN, CHICKEN, RUN");

  await play(page, frame);
  await page.getByRole("button", { name: "pause", exact: true }).click();
  await expect
    .poll(() =>
      frame.evaluate(() => (window as never as { __stc: { state(): string } }).__stc.state()),
    )
    .toBe("paused");
  await page.getByRole("button", { name: "resume" }).click();
  await expect
    .poll(() =>
      frame.evaluate(() => (window as never as { __stc: { state(): string } }).__stc.state()),
    )
    .toBe("countdown");
  await advance(page, 3200);
  await die(page, frame);
});

test("commands from other windows are ignored (EMB-05)", async ({ page }) => {
  await page.goto(`${HOST}/?lang=fr`);
  const frame = await gameFrame(page);
  await stcReady(frame);
  // A message from the game's own window (not its parent) must not count as a host command.
  await frame.evaluate(() =>
    window.postMessage({ ns: "boustan-game", v: 1, cmd: "setLanguage", value: "en" }, "*"),
  );
  await advance(page, 200);
  await expect(frame.locator("html")).toHaveAttribute("lang", "fr");
});

test("a site outside ALLOWED_HOSTS can't embed; the standalone URL still works (AC-12)", async ({
  page,
}) => {
  const blocked: string[] = [];
  page.on("console", (m) => {
    if (/frame-ancestors/i.test(m.text())) blocked.push(m.text());
  });
  await page.goto(`${BLOCKED_HOST}/?lang=fr`);
  await advance(page, 3000);
  expect((await dataLayer(page)).length).toBe(0);
  const frame = await gameFrame(page).catch(() => null);
  const loaded = frame ? await frame.evaluate(() => "__stc" in window).catch(() => false) : false;
  expect(loaded).toBe(false);

  await page.goto("/?lang=fr");
  await stcReady(page);
  await expect(page.getByTestId("play")).toBeVisible();
});

test("plain 300 × 400 iframe: playable, overlays scroll inside (EMB-01)", async ({ page }) => {
  await page.goto(`${HOST}/?mode=iframe&w=300&h=400&lang=fr`);
  const frame = await gameFrame(page);
  await stcReady(frame);
  const overflowX = await frame.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflowX).toBe(false);
  // The start card is taller than 400 px: it scrolls inside the overlay.
  const scrolls = await frame.evaluate(() => {
    const o = document.querySelector(".overlay") as HTMLElement;
    return o.scrollHeight > o.clientHeight;
  });
  expect(scrolls).toBe(true);
  await frame.getByTestId("play").scrollIntoViewIfNeeded();
  await play(page, frame);
});

test("below 300 × 400 the game offers full screen instead (EMB-01)", async ({ page }) => {
  await page.goto(`${HOST}/?mode=iframe&w=280&h=380&lang=fr`);
  const frame = await gameFrame(page);
  await stcReady(frame);
  const link = frame.getByRole("link", { name: "JOUER EN PLEIN ÉCRAN" });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("href", /lang=fr/);
});

test("sound is off by default in embeds; ?muted=0 turns it on (GAME-10)", async ({ page }) => {
  await page.goto(`${HOST}/?lang=en`);
  let frame = await gameFrame(page);
  await stcReady(frame);
  await expect(frame.getByRole("button", { name: "Sound" }).first()).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.goto(`${HOST}/?lang=en&muted=0`);
  frame = await gameFrame(page);
  await stcReady(frame);
  await expect(frame.getByRole("button", { name: "Sound" }).first()).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("pauses when the iframe scrolls out of view (GAME-09, AC-10)", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 800 });
  await page.goto(`${HOST}/?lang=en&width=400`);
  const frame = await gameFrame(page);
  await stcReady(frame);
  await play(page, frame);
  await cheat(frame, { invincible: true });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect.poll(async () => (await snapshot(frame)).state).toBe("paused");
});

test("landscape at 1280 px wide fits without scrolling (EMB-01)", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 1000 });
  await page.goto(`${HOST}/?lang=fr&width=1280`);
  const frame = await gameFrame(page);
  await stcReady(frame);
  // The backing store is a whole multiple of the 320 x 180 logical canvas, so type stays sharp.
  const canvas = await frame.locator("canvas").evaluate((c: HTMLCanvasElement) => ({
    width: c.width,
    height: c.height,
    logicalW: c.dataset.logicalW,
    logicalH: c.dataset.logicalH,
  }));
  expect([canvas.logicalW, canvas.logicalH]).toEqual(["320", "180"]);
  expect(canvas.width % 320).toBe(0);
  expect(canvas.width / canvas.height).toBeCloseTo(320 / 180, 3);
  await expect
    .poll(() =>
      frame.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1),
    )
    .toBe(true);
  await play(page, frame);
});
