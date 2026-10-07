import { expect, test } from "@playwright/test";
import {
  advance,
  cheat,
  die,
  lastResult,
  play,
  saveScore,
  scoreAndDie,
  simulate,
  snapshot,
  stcReady,
  watchConsole,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await page.clock.install();
});

test("full run in French: live points, the results math, then save (AC-01, AC-02)", async ({
  page,
}) => {
  const errors = watchConsole(page);
  await page.goto("/?lang=fr");
  await stcReady(page);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Sauvez le");
  await play(page);

  // The HUD counts 1 point per whole metre plus 10 per garlic as the run goes.
  await cheat(page, { invincible: true, magnet: true });
  await simulate(page, page, 21.5);
  const snap = await snapshot(page);
  expect(snap.state).toBe("play");
  expect(snap.garlic).toBeGreaterThan(0);
  expect(snap.points).toBe(Math.floor(snap.distanceM) + 10 * snap.garlic);
  await expect(page.getByTestId("hud-points")).toHaveText(String(snap.points));
  await expect(page.getByTestId("hud-garlic")).toHaveText(String(snap.garlic));

  await die(page);
  await expect(page.getByRole("heading", { name: "Repose en pita" })).toBeVisible();
  const run = await lastResult(page);
  const metres = Math.floor(run.distanceM);
  expect(run.points).toBe(metres + 10 * run.garlic);
  await expect(page.getByTestId("points")).toHaveText(String(run.points));
  await expect(page.getByTestId("by-distance")).toHaveText(`${metres} m × 1`);
  await expect(page.getByTestId("by-garlic")).toHaveText(`${run.garlic} sauces à l'ail × 10`);
  await expect(page.getByTestId("hits")).toHaveText(
    `${run.hits} ${run.hits > 1 ? "coups" : "coup"}`,
  );
  await expect(
    page.getByText("Enregistrez vos points pour entrer au classement. Les 3 premiers gagnent."),
  ).toBeVisible();
  await expect(page.getByText(/^Rang prévu au classement : #\d+$/)).toBeVisible();
  // The top 3, each marked as a winner.
  await expect(page.locator(".preview tbody tr")).toHaveCount(3);
  await expect(page.locator(".preview .tag")).toHaveText(["GAGNANT", "GAGNANT", "GAGNANT"]);

  await page.getByRole("button", { name: "ENREGISTRER MES POINTS" }).click();
  await expect(page.getByRole("heading", { name: "Enregistrez vos points" })).toBeVisible();
  await expect(page.getByText(`Inscrivez vos ${run.points} points au classement.`)).toBeVisible();
  await page.getByLabel("Votre courriel").fill("alex.tremblay+jeu@gmail.com");
  await page.getByLabel(/J'ai 14 ans ou plus/).check();
  await expect(page.getByLabel(/Envoyez-moi les offres/)).not.toBeChecked();
  await page.getByRole("button", { name: "ENREGISTRER MES POINTS" }).click();
  await advance(page, 500);

  await expect(page.getByRole("heading", { name: "Vous êtes au classement" })).toBeVisible();
  const standing = page.getByTestId("saved").locator("dd");
  await expect(standing.first()).toHaveText(/^#\d+$/);
  await expect(standing.last()).toHaveText(String(run.points));
  await expect(
    page.getByText(/^À la fin du concours, le .+, les 3 premiers du classement gagnent\./),
  ).toBeVisible();
  const order = page.getByRole("link", { name: /COMMANDER EN LIGNE/ });
  await expect(order).toHaveAttribute("target", "_blank");
  await expect(order).toHaveAttribute("rel", "noopener");
  await expect(order).toHaveAttribute("href", /utm_source=game&utm_medium=embed&utm_campaign=/);
  expect(errors).toEqual([]);
});

test("the start screen shows how a run scores and who wins", async ({ page }) => {
  await page.goto("/?lang=en");
  await stcReady(page);
  await advance(page, 300);
  await expect(
    page.getByText("No finish line. Every metre is a point, every garlic is ten."),
  ).toBeVisible();
  const panel = page.getByRole("region", { name: "How scoring works" });
  await expect(panel).toContainText("1 PT per metre");
  await expect(panel).toContainText("10 PTS per garlic");
  await expect(panel).toContainText("THE TOP 3 ON THE LEADERBOARD WIN");
  await expect(page.locator(".campaign-note")).toHaveCount(0);
});

const CLOSED = [
  { scenario: "not_started", note: /^The contest starts .+\s\d{4}\. Warm up!$/ },
  { scenario: "ended", note: /^The contest has ended\. See the final results!$/ },
  { scenario: "board_off", note: /^The leaderboard is paused\. Play for fun!$/ },
];

for (const { scenario, note } of CLOSED) {
  test(`${scenario}: playable for fun, nothing to save`, async ({ page }) => {
    await page.goto(`/?lang=en&mock=${scenario}`);
    await stcReady(page);
    await advance(page, 300);
    await expect(page.locator(".campaign-note")).toHaveText(note);
    await expect(page.getByTestId("scoring")).toHaveCount(0);
    await play(page);
    await die(page);
    await expect(page.locator(".note[role=status]")).toHaveText(note);
    await expect(page.getByRole("button", { name: "SAVE MY SCORE" })).toHaveCount(0);
    await expect(page.getByTestId("points")).toBeVisible();
  });
}

test("once the contest has ended, the board shows the final top 3", async ({ page }) => {
  await page.goto("/?lang=fr&mock=ended");
  await stcReady(page);
  await page.getByRole("button", { name: "CLASSEMENT" }).click();
  await advance(page, 300);
  await expect(page.getByTestId("contest")).toHaveText(
    "Résultats finaux : les 3 premiers ont gagné.",
  );
  await expect(page.locator(".board tbody tr .tag")).toHaveCount(3);
});

test("the save form checks the email, the rules box and the nickname", async ({ page }) => {
  await page.goto("/?lang=en");
  await stcReady(page);
  await play(page);
  await scoreAndDie(page);
  await page.getByRole("button", { name: "SAVE MY SCORE" }).click();
  const submit = page.getByRole("button", { name: "SAVE MY SCORE" });
  await submit.click();
  await expect(page.getByText("Enter a valid email address.")).toBeVisible();
  await expect(
    page.getByText("Confirm you're 14 or older and accept the contest rules."),
  ).toBeVisible();
  await expect(page.getByLabel("Your email")).toBeFocused();

  await page.getByLabel("Your email").fill("sam.roy@gmail.com");
  await page.getByLabel("Nickname (optional)").fill("x");
  await page.getByLabel(/I'm 14 or older/).check();
  await submit.click();
  await expect(page.getByText("Use 2–16 letters, numbers, spaces or - _ . '")).toBeVisible();
  await expect(page.getByLabel("Nickname (optional)")).toBeFocused();
  await page.getByRole("button", { name: "New name" }).click();
  const nickname = await page.getByLabel("Nickname (optional)").inputValue();
  expect(nickname).toMatch(/^\S+ \S+ \d+$/);

  await submit.click();
  await advance(page, 500);
  await expect(page.getByRole("heading", { name: "You're on the leaderboard" })).toBeVisible();
  // The board shows the nickname, never the email.
  await page.getByRole("button", { name: "LEADERBOARD" }).click();
  await advance(page, 300);
  await expect(page.locator(".board tr.me")).toContainText(`YOU · ${nickname}`);
  await expect(page.locator(".board")).not.toContainText("@");
});

test("a returning device is saved as the run finishes (LB-02)", async ({ page }) => {
  await page.goto("/?lang=en");
  await stcReady(page);
  await play(page);
  await scoreAndDie(page);
  await saveScore(page, page, "jo@videotron.ca");
  await expect(page.getByRole("heading", { name: "You're on the leaderboard" })).toBeVisible();

  await page.reload();
  await stcReady(page);
  await play(page);
  await die(page);
  await expect(page.getByText(/^Saved! You're #\d+ on the leaderboard\.$/)).toBeVisible();
  await expect(page.getByRole("button", { name: "SAVE MY SCORE" })).toHaveCount(0);
});

test("your own row: below the top 10 after a short run, first after a long one", async ({
  page,
}) => {
  await page.goto("/?lang=en");
  await stcReady(page);
  await play(page);
  await die(page);
  await saveScore(page, page, "low.score@example.com");
  await page.getByRole("button", { name: "LEADERBOARD" }).click();
  await advance(page, 300);
  const rows = page.locator(".board tbody tr");
  await expect(rows).toHaveCount(11);
  await expect(rows.last()).toHaveClass(/\bme\b/);
  await expect(rows.last()).toContainText("YOU ·");
  await expect(page.getByText(/^You: #1\d$/)).toBeVisible();

  // Back to the saved screen, then a long run takes first place and is saved as it finishes.
  await page.getByRole("button", { name: /BACK/ }).click();
  await page.getByRole("button", { name: "PLAY AGAIN" }).click();
  await advance(page, 400);
  await scoreAndDie(page, page, 90);
  await expect(page.getByText("Saved! You're #1 on the leaderboard.")).toBeVisible();
  await expect(page.locator(".preview tr.me")).toContainText("WINNER");
  await page.getByRole("button", { name: "LEADERBOARD" }).click();
  await advance(page, 300);
  await expect(rows).toHaveCount(10);
  await expect(rows.first()).toHaveClass(/\bme\b/);
  await expect(rows.first()).toContainText("WINNER");
});

test("switching language mid-run keeps the run going (L10N-03, AC-09)", async ({ page }) => {
  await page.goto("/?lang=fr");
  await stcReady(page);
  await play(page);
  await cheat(page, { invincible: true });
  await advance(page, 5000);
  const before = await snapshot(page);
  await expect(page.locator(".spit-label")).toHaveText("BROCHE");
  await page.getByRole("button", { name: "EN", exact: true }).first().click();
  await advance(page, 1000);
  const after = await snapshot(page);
  expect(after.state).toBe("play");
  expect(after.runTime).toBeGreaterThan(before.runTime);
  await expect(page.locator(".spit-label")).toHaveText("SPIT");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("auto-pause on a hidden tab, 3-2-1 on resume, paused time not counted (GAME-09)", async ({
  page,
}) => {
  await page.goto("/?lang=en");
  await stcReady(page);
  await play(page);
  await cheat(page, { invincible: true });
  await advance(page, 2000);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const paused = await snapshot(page);
  expect(paused.state).toBe("paused");
  await advance(page, 5000);
  expect((await snapshot(page)).activeMs).toBe(paused.activeMs);

  await page.getByRole("button", { name: "RESUME" }).click();
  expect((await snapshot(page)).state).toBe("countdown");
  await advance(page, 3100);
  const resumed = await snapshot(page);
  expect(resumed.state).toBe("play");
  expect(resumed.activeMs - paused.activeMs).toBeLessThan(1000);

  await page.keyboard.press("Escape");
  expect((await snapshot(page)).state).toBe("paused");
});

test("offline: the run plays on a local seed and results explain (§3.4)", async ({ page }) => {
  await page.goto("/?lang=en&mock=offline");
  await stcReady(page);
  await page.getByTestId("play").click();
  await advance(page, 3000);
  expect((await snapshot(page)).state).toBe("play");
  await die(page);
  await expect(
    page.getByText("Scores need a connection. Your best is kept on this device."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "SAVE MY SCORE" })).toHaveCount(0);
});

test("a forged run fails validation with a generic message (SEC-03)", async ({ page }) => {
  await page.goto("/?lang=en&mock=invalid");
  await stcReady(page);
  await play(page);
  await scoreAndDie(page);
  await expect(page.getByText("We couldn't verify this run.")).toBeVisible();
  await expect(page.getByRole("button", { name: "SAVE MY SCORE" })).toHaveCount(0);
  await expect(page.locator(".preview")).toHaveCount(0);
});

test("a failed save keeps the form values and can be retried (§3.4)", async ({ page }) => {
  await page.goto("/?lang=en&mock=save_error");
  await stcReady(page);
  await play(page);
  await scoreAndDie(page);
  await page.getByRole("button", { name: "SAVE MY SCORE" }).click();
  await page.getByLabel("Your email").fill("retry@example.com");
  await page.getByLabel(/I'm 14 or older/).check();
  await page.getByRole("button", { name: "SAVE MY SCORE" }).click();
  await advance(page, 500);
  await expect(page.locator(".card [role=alert]")).toHaveText(
    "Something went wrong. Your score is safe, so try again.",
  );
  await expect(page.getByLabel("Your email")).toHaveValue("retry@example.com");
  await page.getByRole("button", { name: "SAVE MY SCORE" }).click();
  await advance(page, 500);
  await expect(page.getByRole("heading", { name: "You're on the leaderboard" })).toBeVisible();
});

test("leaderboard: the top 10 by points, the top 3 marked as winners, no emails (LB-04)", async ({
  page,
}) => {
  await page.goto("/?lang=fr");
  await stcReady(page);
  await page.getByRole("button", { name: "CLASSEMENT" }).click();
  await advance(page, 300);
  await expect(page.getByTestId("contest")).toHaveText(
    /^Les 3 premiers gagnent à la fin du concours, le .+\.$/,
  );
  await expect(page.locator(".board thead th")).toHaveText(["#", "NOM", "POINTS"]);
  const rows = page.locator(".board tbody tr");
  await expect(rows).toHaveCount(10);
  const points = (await rows.locator("td:nth-child(3)").allTextContents()).map((p) =>
    Number(p.replace(/\D/g, "")),
  );
  expect(points).toEqual([...points].sort((a, b) => b - a));
  await expect(rows.locator(".tag")).toHaveText(["GAGNANT", "GAGNANT", "GAGNANT"]);
  await expect(rows.nth(3).locator(".tag")).toHaveCount(0);
  await expect(page.locator(".board caption")).toHaveText(
    "Classement par points : 1 par mètre, 10 par sauce à l'ail. En cas d'égalité, le premier arrivé passe devant.",
  );
  await expect(page.locator(".board")).not.toContainText("@");
});

test("keyboard: Space starts and jumps", async ({ page }) => {
  await page.goto("/?lang=en");
  await stcReady(page);
  await advance(page, 300);
  await page.locator("body").press("Space");
  await advance(page, 400);
  expect((await snapshot(page)).state).toBe("play");
  await page.keyboard.press("Space");
  await advance(page, 100);
  expect((await snapshot(page)).state).toBe("play");
});

test("touch scrolling is blocked over the game only during a run (EMB-08)", async ({ page }) => {
  await page.goto("/?lang=en");
  await stcReady(page);
  const touchAction = () =>
    page.locator(".frame").evaluate((el) => getComputedStyle(el).touchAction);
  expect(await touchAction()).not.toBe("none");
  await play(page);
  expect(await touchAction()).toBe("none");
  await die(page);
  expect(await touchAction()).not.toBe("none");
  expect(await page.locator("body").evaluate((el) => getComputedStyle(el).touchAction)).not.toBe(
    "none",
  );
});

test("Challenge a friend copies the text and a src=share link when sharing isn't available (GAME-16)", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "clipboard permissions are Chromium-only in Playwright");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
  });
  await page.goto("/?lang=fr");
  await stcReady(page);
  await play(page);
  await die(page);
  await page.getByRole("button", { name: "LANCER UN DÉFI" }).click();
  await expect(page.getByRole("status").filter({ hasText: "COPIÉ!" })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(
    /^J'ai marqué \d+ points dans Sauvez le poulet \(\d+ m \+ \d+ sauces? à l'ail\)\. Pouvez-vous finir parmi les 3 premiers\?/,
  );
  expect(copied).toMatch(/http:\/\/localhost:3100\/\?src=share$/);
});
