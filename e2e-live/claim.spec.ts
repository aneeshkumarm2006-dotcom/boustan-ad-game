import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { cheat, setHeat, snapshot, stcReady } from "../e2e/helpers";
import { LIVE_DATABASE_URL } from "../playwright.live.config";

const sql = postgres(LIVE_DATABASE_URL, { max: 2, onnotice: () => {} });
test.afterAll(() => sql.end());

const INVALID = {
  valid: false,
  unlocked: [],
  claimToken: null,
  best: null,
  rankPreview: null,
  rank: null,
};

/** The sandboxed email (written to .emails/ without a provider key) that holds `code`. */
function emailWith(code: string, since: number): string | null {
  const dir = path.resolve(".emails");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith("sandbox-") && f.endsWith(".txt"));
  } catch {
    return null;
  }
  for (const f of files) {
    const file = path.join(dir, f);
    if (statSync(file).mtimeMs < since) continue;
    const text = readFileSync(file, "utf8");
    if (text.includes(code)) return text;
  }
  return null;
}

test("a real run unlocks both rewards; the claim issues two pool codes and one email", async ({
  page,
}) => {
  const started = Date.now();
  // The dev server compiles a route on first use; PLAY only waits 1.2 s for a run token.
  await page.request.post("/api/runs/start", {
    data: { src: null, lang: "fr", utm: {}, host: null },
  });
  const token = page.waitForResponse((r) => r.url().endsWith("/api/runs/start"));
  await page.goto("/?lang=fr&src=e2e-live");
  expect((await token).status()).toBe(200);
  await stcReady(page);
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

  await page.getByRole("button", { name: "RÉCLAMER MES RÉCOMPENSES" }).click();
  const email = `E2E.Player+${started}@example.com`;
  await page.getByLabel("Votre courriel").fill(email);
  await page.getByLabel(/J'ai 14 ans ou plus/).check();
  await page.getByLabel(/Envoyez-moi les offres/).check();
  await page.getByRole("button", { name: "RÉCLAMER MES RÉCOMPENSES" }).click();

  // The coupon screen shows a code per reward from the imported pool (RWD-03, AC-01, AC-02).
  const coupons = page.getByTestId("coupon");
  await expect(coupons).toHaveCount(2, { timeout: 20_000 });
  const shown = await coupons.locator(".code").allTextContents();
  expect(shown[0]).toMatch(/^E2E-COKE-\d{3}$/);
  expect(shown[1]).toMatch(/^E2E-GARL-\d{3}$/);
  await expect(page.getByText("Aussi envoyé à E•••@example.com")).toBeVisible();

  const [player] = await sql`select id, email, email_normalized, marketing_opt_in, first_src
    from players where email = ${email}`;
  expect(player).toMatchObject({
    email_normalized: `e2e.player@example.com`,
    marketing_opt_in: true,
    first_src: "e2e-live",
  });
  const issued = await sql`select c.code, c.status from codes c
    join claims cl on cl.code_id = c.id where cl.player_id = ${player.id} order by c.code`;
  expect(issued.map((r) => [r.code, r.status])).toEqual([
    [shown[0], "assigned"],
    [shown[1], "assigned"],
  ]);
  const consents = await sql`select kind, granted, text_version, ip is not null as has_ip
    from consents where player_id = ${player.id} order by id`;
  expect(consents.map((c) => [c.kind, c.granted, c.has_ip])).toEqual([
    ["terms_age", true, true],
    ["marketing", true, true],
  ]);
  const [run] =
    await sql`select status, src, client_version from runs where player_id = ${player.id}`;
  expect(run).toMatchObject({ status: "valid", src: "e2e-live", client_version: "dev" });

  // One email with both codes, sent after the response (MAIL-02, MAIL-05).
  await expect.poll(() => emailWith(shown[0], started) !== null, { timeout: 30_000 }).toBe(true);
  const text = emailWith(shown[0], started)!;
  expect(text).toContain(shown[1]);
  expect(text).toContain("Subject: Votre Coke et votre sauce à l'ail gratuits vous attendent");
  const [outbox] = await sql`select status, kind from email_outbox where player_id = ${player.id}`;
  expect(outbox).toMatchObject({ status: "sent", kind: "coupon" });

  // The other-language link shows the same codes in English (MAIL-03).
  const view = /http:\/\/localhost:3300\/api\/email\/view\?t=[\w.-]+&lang=en/.exec(text)![0];
  const viewed = await page.request.get(view);
  expect(viewed.status()).toBe(200);
  expect(await viewed.text()).toContain(shown[0]);

  // Resend from the coupon screen (MAIL-08).
  await page.getByRole("button", { name: "RENVOYER LE COURRIEL" }).click();
  await expect(page.getByRole("button", { name: "COURRIEL ENVOYÉ" })).toBeVisible();
  await expect
    .poll(
      async () =>
        (
          await sql`select count(*)::int as n from email_outbox
      where player_id = ${player.id} and kind = 'resend' and status = 'sent'`
        )[0].n,
    )
    .toBe(1);

  // The unsubscribe link in the email works and is logged (AC-07).
  const unsub = /http:\/\/localhost:3300\/api\/unsubscribe\?t=[\w.-]+/.exec(text)![0];
  const res = await page.request.get(unsub);
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain("Désabonnement confirmé");
  const [after] = await sql`select marketing_opt_in from players where id = ${player.id}`;
  expect(after.marketing_opt_in).toBe(false);
  const [withdrawn] = await sql`select source from consents
    where player_id = ${player.id} and kind = 'marketing' and granted = false`;
  expect(withdrawn.source).toBe("unsubscribe");
});

test("forged finish requests get no reward and are flagged (AC-05)", async ({ request }) => {
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
  const [row] = await sql`select status, flag_reason from runs where id = ${run.runId}`;
  expect(row).toMatchObject({ status: "flagged", flag_reason: "too_fast" });

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

  // A claim with no valid claim token.
  const claim = await request.post("/api/claim", {
    data: {
      claimToken: "nope",
      email: "x@example.com",
      lang: "en",
      termsAge: true,
      marketingOptIn: false,
      turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
      src: null,
      utm: {},
    },
  });
  expect(claim.status()).toBe(400);
});

test("security headers and the always-202 resend (SEC-09, MAIL-08)", async ({ request }) => {
  const page = await request.get("/");
  const csp = page.headers()["content-security-policy"];
  expect(csp).toContain("frame-ancestors 'self' http://127.0.0.1:3200");
  expect(csp).toContain("script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com");
  expect(csp).toContain("object-src 'none'");
  expect(page.headers()["strict-transport-security"]).toContain("max-age=63072000");

  const api = await request.post("/api/runs/start", {
    data: { src: null, lang: "fr", utm: {}, host: null },
  });
  expect(api.headers()["content-security-policy"]).toBe(
    "default-src 'none'; frame-ancestors 'none'",
  );
  expect(api.headers()["cache-control"]).toBe("no-store");

  const bad = await request.post("/api/runs/start", { data: "{" });
  expect(bad.status()).toBe(400);

  for (const email of ["nobody@unknown.example", "not-an-email"]) {
    const res = await request.post("/api/claim/resend", { data: { email } });
    expect(res.status()).toBe(202);
  }

  const unsub = await request.get("/api/unsubscribe?t=forged");
  expect(unsub.status()).toBe(400);
  expect(unsub.headers()["content-security-policy"]).toContain("style-src 'unsafe-inline'");
});
