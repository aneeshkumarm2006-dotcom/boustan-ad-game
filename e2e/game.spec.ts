import { expect, test } from "@playwright/test";
import {
  advance,
  cheat,
  die,
  play,
  simulate,
  snapshot,
  stcReady,
  unlockBothAndDie,
  watchConsole,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await page.clock.install();
});

test("full run in French: both rewards, one claim, two codes (AC-01, AC-02)", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/?lang=fr");
  await stcReady(page);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("SAUVEZ LE");
  await play(page);

  // 100 m unlocks the Coke mid-run; the run keeps going (GAME-02).
  await cheat(page, { invincible: true, magnet: true });
  await simulate(page, page, 21.5);
  await expect(page.getByTestId("announce")).toHaveText("COKE GRATUIT DÉBLOQUÉ!");
  expect((await snapshot(page)).state).toBe("play");
  await expect(page.getByTestId("hud-distance")).toHaveText(/^1\d\d m$/);

  await unlockBothAndDie(page);
  await expect(page.getByRole("heading", { name: "REPOSE EN PITA" })).toBeVisible();
  await page.getByRole("button", { name: "RÉCLAMER MES RÉCOMPENSES" }).click();

  await page.getByLabel("Votre courriel").fill("alex.tremblay+jeu@gmail.com");
  await page.getByLabel(/J'ai 14 ans ou plus/).check();
  await expect(page.getByLabel(/Envoyez-moi les offres/)).not.toBeChecked();
  await page.getByRole("button", { name: "RÉCLAMER MES RÉCOMPENSES" }).click();
  await advance(page, 500);

  const coupons = page.getByTestId("coupon");
  await expect(coupons).toHaveCount(2);
  await expect(coupons.first()).toContainText(/TEST-[0-9A-Z]{4}-[0-9A-Z]{4}/);
  await expect(page.getByText("Aussi envoyé à a•••@gmail.com")).toBeVisible();
  await expect(page.getByText(/Expire le \d{1,2} [a-zé]+\.? 20\d\d/).first()).toBeVisible();
  const order = page.getByRole("link", { name: /COMMANDER EN LIGNE/ });
  await expect(order).toHaveAttribute("target", "_blank");
  await expect(order).toHaveAttribute("rel", "noopener");
  await expect(order).toHaveAttribute("href", /utm_source=game&utm_medium=embed&utm_campaign=/);
  expect(errors).toEqual([]);
});

test("the same email can't claim twice, Gmail variants included (AC-03)", async ({ page }) => {
  await page.goto("/?lang=en");
  await stcReady(page);
  const claimWith = async (email: string) => {
    await unlockBothAndDie(page);
    await page.getByRole("button", { name: "CLAIM MY REWARDS" }).click();
    const notYou = page.getByRole("button", { name: "Not you?" });
    if (await notYou.isVisible()) await notYou.click();
    await page.getByLabel("Your email").fill(email);
    await page.getByLabel(/I'm 14 or older/).check();
    await page.getByRole("button", { name: "CLAIM MY REWARDS" }).click();
    await advance(page, 500);
  };
  await play(page);
  await claimWith("sam.roy@gmail.com");
  await expect(page.getByTestId("coupon")).toHaveCount(2);
  await page.getByRole("button", { name: "PLAY AGAIN" }).click();
  await advance(page, 400);
  await claimWith("SamRoy+again@googlemail.com");
  await expect(page.getByTestId("coupon")).toHaveCount(0);
  await expect(page.getByText("Already claimed: we've re-sent your code.")).toBeVisible();
});

test("returning players claim with one tap and see My rewards", async ({ page }) => {
  await page.goto("/?lang=en");
  await stcReady(page);
  await play(page);
  await unlockBothAndDie(page);
  await page.getByRole("button", { name: "CLAIM MY REWARDS" }).click();
  await page.getByLabel("Your email").fill("jo@videotron.ca");
  await page.getByLabel(/I'm 14 or older/).check();
  await page.getByRole("button", { name: "CLAIM MY REWARDS" }).click();
  await advance(page, 500);
  await expect(page.getByTestId("coupon")).toHaveCount(2);

  await page.reload();
  await stcReady(page);
  await page.getByRole("button", { name: "MY REWARDS" }).click();
  await expect(page.getByTestId("coupon")).toHaveCount(2);
  await page.getByRole("button", { name: /BACK/ }).click();

  // No reward this time: the score of a known device is saved when the run finishes (LB-02),
  // so there is no "Save my score" button, just the rank.
  await play(page);
  await die(page);
  await advance(page, 500);
  await expect(page.getByText(/Score saved! Rank: #\d+/)).toBeVisible();
  await expect(page.getByRole("button", { name: "SAVE MY SCORE" })).toHaveCount(0);
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

test("campaign over: playable, no reward cards", async ({ page }) => {
  await page.goto("/?lang=fr&mock=ended");
  await stcReady(page);
  await advance(page, 300);
  await expect(
    page.getByText("Cette promotion est terminée. Jouez pour le plaisir!"),
  ).toBeVisible();
  await expect(page.locator(".reward")).toHaveCount(0);
  await play(page);
  await unlockBothAndDie(page);
  await expect(page.getByRole("button", { name: /RÉCLAMER/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "ENREGISTRER MON POINTAGE" })).toBeVisible();
});

test("sold-out reward shows All gone (§3.4)", async ({ page }) => {
  await page.goto("/?lang=fr&mock=soldout_coke");
  await stcReady(page);
  await advance(page, 300);
  await expect(page.locator('.reward[data-status="gone"]')).toContainText("Épuisé pour l'instant");
  await play(page);
  await unlockBothAndDie(page);
  await expect(page.getByRole("button", { name: "RÉCLAMER MA RÉCOMPENSE" })).toBeVisible();
});

test("offline: the run plays on a local seed and results explain (§3.4)", async ({ page }) => {
  await page.goto("/?lang=en&mock=offline");
  await stcReady(page);
  await page.getByTestId("play").click();
  await advance(page, 3000);
  expect((await snapshot(page)).state).toBe("play");
  await die(page);
  await expect(
    page.getByText("Rewards need a connection. Your score is saved on this device."),
  ).toBeVisible();
});

test("a forged run fails validation with a generic message (SEC-03)", async ({ page }) => {
  await page.goto("/?lang=en&mock=invalid");
  await stcReady(page);
  await play(page);
  await unlockBothAndDie(page);
  await expect(page.getByText("We couldn't verify this run.")).toBeVisible();
  await expect(page.getByRole("button", { name: /CLAIM/ })).toHaveCount(0);
});

test("a failed claim keeps the form values and can be retried (§3.4)", async ({ page }) => {
  await page.goto("/?lang=en&mock=claim_error");
  await stcReady(page);
  await play(page);
  await unlockBothAndDie(page);
  await page.getByRole("button", { name: "CLAIM MY REWARDS" }).click();
  await page.getByLabel("Your email").fill("retry@example.com");
  await page.getByLabel(/I'm 14 or older/).check();
  await page.getByRole("button", { name: "CLAIM MY REWARDS" }).click();
  await advance(page, 500);
  await expect(page.locator(".card [role=alert]")).toHaveText(/Something went wrong/);
  await expect(page.getByLabel("Your email")).toHaveValue("retry@example.com");
  await page.getByRole("button", { name: "CLAIM MY REWARDS" }).click();
  await advance(page, 500);
  await expect(page.getByTestId("coupon")).toHaveCount(2);
});

test("leaderboard shows the top 10 with no emails (LB-04)", async ({ page }) => {
  await page.goto("/?lang=fr");
  await stcReady(page);
  await page.getByRole("button", { name: "CLASSEMENT" }).click();
  await advance(page, 300);
  const rows = page.locator(".board tbody tr");
  await expect(rows).toHaveCount(10);
  await expect(page.locator(".board")).not.toContainText("@");
  await expect(page.locator(".board").getByText("SANS FAUTE").first()).toBeVisible();
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
    /^J'ai couru \d+ m et attrapé \d+ sauces? à l'ail dans Sauvez le poulet\./,
  );
  expect(copied).toMatch(/http:\/\/localhost:3100\/\?src=share$/);
});
