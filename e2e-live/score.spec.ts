import { expect, test } from "@playwright/test";
import { createDb } from "../db/client";
import { newPlayer } from "../db/schema";
import { cheat, lastResult, setHeat, snapshot, stcReady } from "../e2e/helpers";
import { ADMIN_PASSWORD, LIVE_MONGODB_URI } from "../playwright.live.config";

const { db, client } = createDb(LIVE_MONGODB_URI, { max: 2 });
test.afterAll(() => client.close());

const INVALID = {
  valid: false,
  points: 0,
  saveToken: null,
  best: null,
  rankPreview: null,
  rank: null,
};

test("a real run is scored on the server, saved to the leaderboard, and a known device saves itself", async ({
  page,
}) => {
  const started = Date.now();
  // The dev server compiles a route on first use; PLAY only waits 1.2 s for a run token.
  await page.request.post("/api/runs/start", {
    data: { src: null, lang: "en", utm: {}, host: null },
  });
  const token = page.waitForResponse((r) => r.url().endsWith("/api/runs/start"));
  await page.goto("/?lang=en&src=e2e-live");
  expect((await token).status()).toBe(200);
  await stcReady(page);
  await expect(page.getByTestId("scoring")).toContainText("1 PT");
  await expect(page.getByTestId("scoring")).toContainText("10 PTS");
  await expect(page.getByTestId("play")).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId("play").click();
  await expect.poll(async () => (await snapshot(page)).state).toBe("play");

  // Real time on purpose: the server checks the run lasted as long as it claims (SEC-02).
  await cheat(page, { invincible: true, magnet: true });
  await expect
    .poll(async () => (await snapshot(page)).distanceM, { timeout: 60_000, intervals: [1000] })
    .toBeGreaterThan(145);
  await cheat(page, { invincible: false, magnet: false });
  await setHeat(page, 3);
  await expect.poll(async () => (await snapshot(page)).state, { timeout: 15_000 }).toBe("over");

  // The results show 1 point per metre plus 10 per garlic.
  const result = await lastResult(page);
  expect(result.points).toBe(Math.floor(result.distanceM) + 10 * result.garlic);
  expect(result.garlic).toBeGreaterThan(0);
  const shown = await page.getByTestId("points").textContent();
  expect(Number(shown!.replace(/\D/g, ""))).toBe(result.points);

  // A new player saves the score with an email; it goes on the leaderboard (AC-02, LB-02).
  const email = `E2E.Player+${started}@example.com`;
  await page.getByLabel("Your email").fill(email);
  await page.getByLabel("Full name").fill("E2E Runner");
  await page.getByLabel(/I'm 14 or older/).check();
  await page.getByLabel(/Send me Boustan offers/).check();
  await page.getByRole("button", { name: "SAVE MY SCORE" }).click();
  await expect(page.getByTestId("saved")).toContainText("#1", { timeout: 20_000 });
  await expect(page.getByTestId("saved")).toContainText(
    String(result.points).replace(/\B(?=(\d{3})+$)/g, ","),
  );

  // The server scored the same run the same way, and kept what a winner is reached by.
  const player = (await db.players.findOne({ email }))!;
  expect(player).toMatchObject({
    emailNormalized: "e2e.player@example.com",
    nickname: "E2E Runner",
    marketingOptIn: true,
    hidden: false,
    firstSrc: "e2e-live",
  });
  const run = (await db.runs.findOne({ playerId: player._id }))!;
  expect(run).toMatchObject({
    status: "valid",
    src: "e2e-live",
    clientVersion: "dev",
    points: result.points,
    garlic: result.garlic,
  });
  expect(run.savedAt).not.toBeNull();
  expect(await db.bestRuns.findOne({ _id: player._id })).toMatchObject({
    runId: run._id,
    points: result.points,
    garlic: result.garlic,
  });
  const consents = await db.consents.find({ playerId: player._id }).sort({ _id: 1 }).toArray();
  expect(consents.map((c) => [c.kind, c.granted, c.source, c.ip !== null])).toEqual([
    ["terms_age", true, "save_form", true],
    ["marketing", true, "save_form", true],
  ]);

  // This device is known now: the next run is saved as it finishes, with no form.
  await page.getByRole("button", { name: "PLAY AGAIN" }).click();
  await expect.poll(async () => (await snapshot(page)).state).toBe("play");
  await setHeat(page, 3);
  await expect.poll(async () => (await snapshot(page)).state, { timeout: 15_000 }).toBe("over");
  await expect(page.getByText(/Saved! You're #1 on the leaderboard/)).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("save")).toHaveCount(0);
  const runs = await db.runs.find({ playerId: player._id }).toArray();
  expect(runs).toHaveLength(2);
  expect(runs.every((r) => r.status === "valid" && r.savedAt !== null)).toBe(true);
  // Only the better run counts.
  expect((await db.bestRuns.findOne({ _id: player._id }))!.runId).toBe(run._id);

  // The leaderboard shows nicknames and points, marks the winners, and never an email.
  await page.getByRole("button", { name: "LEADERBOARD" }).click();
  await expect(page.getByTestId("contest")).toContainText("top 3 win");
  const row = page.locator(".board tr.me");
  await expect(row).toContainText("YOU");
  await expect(row).toContainText("WINNER");
  const board = await (await page.request.get("/api/leaderboard?limit=7")).json();
  expect(board.top).toEqual([{ rank: 1, name: player.nickname, points: result.points }]);
  expect(JSON.stringify(board)).not.toContain("example.com");
});

test("the admin sees the winners, can reach them and exports them", async ({ page, request }) => {
  // Four players put straight on the board, far above anything a test run scores.
  const ranked = [
    ["first@e2e.test", "Gold", 3000],
    ["second@e2e.test", "Silver", 2000],
    ["third@e2e.test", "Bronze", 1000],
    ["fourth@e2e.test", "Tin", 900],
  ] as const;
  for (const [i, [email, nickname, points]] of ranked.entries()) {
    const player = newPlayer({ email, emailNormalized: email, language: "en", nickname });
    await db.players.insertOne(player);
    await db.bestRuns.insertOne({
      _id: player._id,
      runId: `00000000-0000-4000-8000-00000000000${i}`,
      points,
      distanceM: points - 100,
      garlic: 10,
      achievedAt: new Date(Date.now() - 60_000 + i),
    });
  }

  // Nothing is reachable without signing in.
  expect((await request.get("/api/admin/export/players")).status()).toBe(401);
  await page.goto("/admin/leaderboard");
  await expect(page).toHaveURL(/\/admin\/login/);

  // A wrong password is refused; the right one signs in.
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Wrong password.")).toBeVisible();
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin$/);

  await page.goto("/admin/leaderboard");
  const winners = page.getByRole("region", { name: "Top 3 right now" });
  await expect(winners).toBeVisible();
  for (const email of ["first@e2e.test", "second@e2e.test", "third@e2e.test"]) {
    await expect(winners.getByRole("link", { name: email })).toBeVisible();
  }
  await expect(winners.getByRole("link", { name: "fourth@e2e.test" })).toHaveCount(0);
  await expect(winners.getByRole("row", { name: /Gold/ })).toContainText("3,000");

  // The CSV has the winners in rank order and nobody else, and the download is logged.
  const csv = await page.request.get("/api/admin/export/players?winners=1");
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  const lines = (await csv.text()).replace(/^﻿/, "").trim().split("\r\n");
  expect(lines[0]).toMatch(/^rank,email,nickname,points,/);
  expect(lines.slice(1).map((l) => l.split(",").slice(0, 4))).toEqual([
    ["1", "first@e2e.test", "Gold", "3000"],
    ["2", "second@e2e.test", "Silver", "2000"],
    ["3", "third@e2e.test", "Bronze", "1000"],
  ]);
  const logged = await db.adminAudit.findOne({ action: "export.winners" });
  expect(logged).toMatchObject({ adminEmail: "admin" });

  // Hiding a winner moves the next player up.
  await page.goto("/admin/leaderboard");
  const board = page.getByRole("region", { name: "Full leaderboard" });
  await board.getByRole("row", { name: /Gold/ }).getByRole("button", { name: "Hide" }).click();
  await expect(board.getByRole("row", { name: /Gold/ })).toContainText("hidden");
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Top 3 right now" }).getByRole("link", {
      name: "fourth@e2e.test",
    }),
  ).toBeVisible();
});

test("forged finish requests earn nothing and are flagged (AC-05)", async ({ request }) => {
  const start = await request.post("/api/runs/start", {
    data: { src: null, lang: "en", utm: {}, host: null },
  });
  expect(start.status()).toBe(200);
  const run = await start.json();

  // 25 s of play claimed a moment after the token was issued.
  const forged = await request.post(`/api/runs/${run.runId}/finish`, {
    data: { token: run.token, distance: 128.1, garlic: 12, hits: 0, activeMs: 25_000 },
  });
  expect(await forged.json()).toEqual(INVALID);
  const row = await db.runs.findOne({ _id: run.runId });
  expect(row).toMatchObject({ status: "flagged", flagReason: "too_fast", points: 0 });
  expect(await db.bestRuns.findOne({ runId: run.runId })).toBeNull();

  // The same token again, and a token with its payload edited.
  const reused = await request.post(`/api/runs/${run.runId}/finish`, {
    data: { token: run.token, distance: 0, garlic: 0, hits: 0, activeMs: 0 },
  });
  expect(await reused.json()).toEqual(INVALID);
  const [body, sig] = run.token.split(".");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString());
  const edited = Buffer.from(JSON.stringify({ ...payload, iat: 0 })).toString("base64url");
  const tampered = await request.post(`/api/runs/${run.runId}/finish`, {
    data: { token: `${edited}.${sig}`, distance: 0, garlic: 0, hits: 0, activeMs: 0 },
  });
  expect(await tampered.json()).toEqual(INVALID);

  // A save with no valid save token.
  const save = await request.post("/api/score", {
    data: {
      saveToken: "nope",
      email: "x@example.com",
      lang: "en",
      termsAge: true,
      marketingOptIn: false,
      turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
      src: null,
      utm: {},
    },
  });
  expect(save.status()).toBe(400);
});

test("security headers on the game, the admin and the API (SEC-09)", async ({ request }) => {
  const page = await request.get("/");
  const csp = page.headers()["content-security-policy"];
  expect(csp).toContain("frame-ancestors 'self' http://127.0.0.1:3200");
  expect(csp).toContain("script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com");
  expect(csp).toContain("object-src 'none'");
  expect(page.headers()["strict-transport-security"]).toContain("max-age=63072000");

  const login = await request.get("/admin/login");
  expect(login.headers()["x-frame-options"]).toBe("DENY");
  expect(login.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");

  for (const api of [
    await request.post("/api/runs/start", {
      data: { src: null, lang: "fr", utm: {}, host: null },
    }),
    await request.get("/api/leaderboard?limit=3"),
  ]) {
    expect(api.headers()["content-security-policy"]).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(api.headers()["cache-control"]).toBe("no-store");
  }

  const bad = await request.post("/api/runs/start", { data: "{" });
  expect(bad.status()).toBe(400);
  const gone = await request.post("/api/claim", { data: {} });
  expect(gone.status()).toBe(404);
});
