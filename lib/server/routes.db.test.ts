import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as cronAlerts } from "@/app/api/cron/alerts/route";
import { GET as cronRetention } from "@/app/api/cron/retention/route";
import { GET as cronRollup } from "@/app/api/cron/rollup/route";
import { POST as postEvents } from "@/app/api/events/route";
import { POST as postFinish } from "@/app/api/runs/[id]/finish/route";
import { POST as postStart } from "@/app/api/runs/start/route";
import { POST as postScore } from "@/app/api/score/route";
import type { Db } from "@/db/client";
import { newEvent } from "@/db/schema";
import {
  GOOD,
  addRanked,
  connect,
  finish,
  pointsFor,
  resetDb,
  runTokenFor,
  seedCampaign,
} from "@/tests/db";
import { resetEnvForTests } from "./env";
import { issuePlayerToken } from "./players";
import { setDbForTests } from "./db";
import { runTokenSchema, saveTokenSchema, signToken, verifyToken } from "./tokens";

// The score route schedules its analytics with after(), which only works inside a Next request.
// Here it runs the task at once, and a test waits for it with afterDone().
const scheduled = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock("next/server", () => ({
  after: (task: (() => unknown) | Promise<unknown>) => {
    scheduled.push(Promise.resolve().then(() => (typeof task === "function" ? task() : task)));
  },
}));
const afterDone = async () => {
  await Promise.all(scheduled.splice(0));
};

const { db, close } = connect(20);
afterAll(close);
beforeEach(async () => {
  await resetDb(db);
  await seedCampaign(db);
  scheduled.length = 0;
});

const original = {
  limits: process.env.RATE_LIMITS,
  secret: process.env.CRON_SECRET,
  vercel: process.env.VERCEL_ENV,
  turnstile: process.env.TURNSTILE_SECRET,
};
type Name = "RATE_LIMITS" | "CRON_SECRET" | "VERCEL_ENV" | "TURNSTILE_SECRET";
const setEnv = (name: Name, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  resetEnvForTests();
};
afterEach(() => {
  setEnv("RATE_LIMITS", original.limits);
  setEnv("CRON_SECRET", original.secret);
  setEnv("VERCEL_ENV", original.vercel);
  setEnv("TURNSTILE_SECRET", original.turnstile);
  setDbForTests(db);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148";
const request = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://game.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    headers: { "user-agent": IPHONE, ...headers },
  });
const bodyOf = async (res: Response) => JSON.parse(await res.text()) as Record<string, unknown>;

describe("POST /api/runs/start (SEC-01)", () => {
  const start = (body: unknown, headers?: Record<string, string>) =>
    postStart(request("/api/runs/start", body, headers));

  it("returns the run, the seed, a signed token and the contest state", async () => {
    const res = await start({
      src: "lapresse",
      lang: "en",
      utm: { utm_campaign: "x" },
      host: "https://news.example/page",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      runId: string;
      seed: number;
      token: string;
      campaign: unknown;
    };
    expect(verifyToken("run", body.token, runTokenSchema)).toMatchObject({
      id: body.runId,
      seed: body.seed,
      src: "lapresse",
      lang: "en",
      host: "https://news.example",
      utm: { utm_campaign: "x" },
    });
    expect(body.campaign).toMatchObject({ status: "active", leaderboardOpen: true });
    expect(await db.runs.countDocuments()).toBe(0);
  });

  it("drops attribution that isn't clean text, and falls back to French", async () => {
    const res = await start({
      src: "<script>",
      lang: "de",
      utm: { utm_source: "<b>" },
      host: "javascript:alert(1)",
    });
    const { token } = (await res.json()) as { token: string };
    expect(verifyToken("run", token, runTokenSchema)).toMatchObject({
      src: null,
      lang: "fr",
      host: null,
      utm: {},
    });
  });

  it("answers 400 to a body that isn't JSON, and 429 past the limit", async () => {
    expect((await start("{")).status).toBe(400);
    setEnv("RATE_LIMITS", "runStart=2/60");
    const ip = { "x-real-ip": "198.51.100.20" };
    expect((await start({}, ip)).status).toBe(200);
    expect((await start({}, ip)).status).toBe(200);
    const limited = await start({}, ip);
    expect(limited.status).toBe(429);
    expect(await bodyOf(limited)).toEqual({ error: "rate_limited" });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another address has its own allowance.
    expect((await start({}, { "x-real-ip": "198.51.100.21" })).status).toBe(200);
  });
});

describe("POST /api/runs/:id/finish (SEC-02 to SEC-04)", () => {
  const finishWith = (id: string, body: unknown, headers?: Record<string, string>) =>
    postFinish(request(`/api/runs/${id}/finish`, body, headers), {
      params: Promise.resolve({ id }),
    });
  const report = (run: ReturnType<typeof GOOD>, token: string) => ({
    token,
    distance: run.distance,
    garlic: run.garlic,
    hits: run.hits,
    activeMs: run.activeMs,
  });

  it("scores a run and answers with points, a save token and the rank it would take", async () => {
    const run = GOOD();
    const { id, token } = runTokenFor(run);
    const res = await finishWith(id, report(run, token), { "x-client-version": "abc123" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      valid: boolean;
      points: number;
      saveToken: string;
      rankPreview: number;
    };
    expect(body).toMatchObject({
      valid: true,
      points: pointsFor(run),
      rankPreview: 1,
      best: null,
      rank: null,
    });
    expect(verifyToken("save", body.saveToken, saveTokenSchema)).toMatchObject({ run: id });
    expect(await db.runs.findOne({ _id: id })).toMatchObject({
      clientVersion: "abc123",
      status: "valid",
    });
  });

  it("recognizes a known device from its header: saved at finish, no save token", async () => {
    const { player } = await addRanked(db, {
      email: "known@example.com",
      nickname: "Known",
      points: 10,
    });
    const run = GOOD();
    const { id, token } = runTokenFor(run);
    const res = await finishWith(id, report(run, token), {
      "x-player-token": await issuePlayerToken(db, player._id),
    });
    expect(await bodyOf(res)).toMatchObject({ valid: true, saveToken: null, rank: 1 });
  });

  it("answers a forged run like a real one, with 200 and nothing to learn from", async () => {
    const run = { ...GOOD(), garlic: 500 };
    const { id, token } = runTokenFor(run);
    const res = await finishWith(id, report(run, token));
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({
      valid: false,
      points: 0,
      saveToken: null,
      best: null,
      rankPreview: null,
      rank: null,
    });
  });

  it("answers 404 to an id that isn't a run id, and 400 to numbers that can't be real", async () => {
    expect((await finishWith("not-a-uuid", {})).status).toBe(404);
    const run = GOOD();
    const { id, token } = runTokenFor(run);
    for (const patch of [
      { distance: -1 },
      { garlic: 1.5 },
      { hits: -2 },
      { activeMs: 2e9 },
      { token: "" },
    ]) {
      expect(
        (await finishWith(id, { ...report(run, token), ...patch })).status,
        JSON.stringify(patch),
      ).toBe(400);
    }
    expect(await db.runs.countDocuments()).toBe(0);
  });
});

describe("POST /api/score (SEC-04, SEC-05, SEC-06)", () => {
  const form = (saveToken: string | null, extra: Record<string, unknown> = {}) => ({
    saveToken,
    email: "route@example.com",
    lang: "fr",
    termsAge: true,
    marketingOptIn: false,
    turnstileToken: "",
    src: "lapresse",
    utm: {},
    ...extra,
  });
  const score = (body: unknown, headers?: Record<string, string>) =>
    postScore(request("/api/score", body, headers));
  const outcomes = async () =>
    (await db.events.find({ name: "api_save" }).sort({ _id: 1 }).toArray()).map(
      (e) => e.props.outcome,
    );

  it("saves the score and answers with the device token, the rank and the best run", async () => {
    const run = GOOD();
    const finished = await finish(db, run);
    const res = await score(form(finished.saveToken, { nickname: "Route Fan" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await bodyOf(res)).toEqual({
      playerToken: expect.stringMatching(/^[\w-]{43}$/),
      rank: 1,
      best: { points: pointsFor(run), distanceM: expect.any(Number), garlic: run.garlic },
    });
    expect(await db.players.findOne()).toMatchObject({
      email: "route@example.com",
      nickname: "Route Fan",
    });
  });

  it("records the save as an api_save event with its placement, language and device, and an opt-in as its own", async () => {
    await score(form((await finish(db, GOOD())).saveToken, { marketingOptIn: true }));
    await afterDone();
    const events = await db.events.find().sort({ _id: 1 }).toArray();
    expect(events.map((e) => [e.name, e.props])).toEqual([
      ["api_save", { outcome: "ok" }],
      ["opt_in", {}],
    ]);
    for (const e of events) {
      expect(e).toMatchObject({ src: "lapresse", lang: "fr", device: "mobile", sessionId: null });
    }
  });

  it.each([
    ["closed", 409],
    ["expired", 410],
    ["rejected", 400],
    ["bad_email", 400],
  ] as const)("answers %s with %i, and records it", async (error, status) => {
    const finished = await finish(db, GOOD());
    const attempts = {
      closed: async () => {
        await db.campaignSettings.updateOne({}, { $set: { leaderboardOpen: false } });
        return form(finished.saveToken);
      },
      // A save token that has run out, signed for a real run.
      expired: async () =>
        form(signToken("save", { v: 1, run: finished.runId, exp: Date.now() - 1 })),
      rejected: async () => form(finished.saveToken, { termsAge: false }),
      bad_email: async () => form(finished.saveToken, { email: "x@mailinator.com" }),
    };
    const res = await score(await attempts[error]());
    expect(res.status).toBe(status);
    expect(await bodyOf(res)).toEqual({ error });
    await afterDone();
    expect(await outcomes()).toEqual([error]);
    expect(await db.events.countDocuments({ name: "opt_in" })).toBe(0);
  });

  it("answers 400 to a body that doesn't fit, and 413 to one that is far too big", async () => {
    const finished = await finish(db, GOOD());
    expect((await score("not json")).status).toBe(400);
    for (const bad of [
      form(finished.saveToken, { termsAge: "yes" }),
      form(finished.saveToken, { marketingOptIn: undefined }),
      form(finished.saveToken, { email: "a".repeat(321) }),
      form(finished.saveToken, { nickname: "n".repeat(65) }),
      form(finished.saveToken, { lang: "de" }),
      form(""),
    ]) {
      expect((await score(bad)).status, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
    expect((await score(form(finished.saveToken, { pad: "x".repeat(9000) }))).status).toBe(413);
    expect(await db.players.countDocuments()).toBe(0);
  });

  it("answers 429 once an address saves too often, before looking at anything else", async () => {
    setEnv("RATE_LIMITS", "saveIp=2/60");
    const ip = { "x-real-ip": "198.51.100.30" };
    for (let i = 0; i < 2; i++) expect((await score("not json", ip)).status).toBe(400);
    const limited = await score(form((await finish(db, GOOD())).saveToken), ip);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await db.players.countDocuments()).toBe(0);
  });

  it("answers 500 to a server error and records it, which is what the save error alert counts", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const finished = await finish(db, GOOD());
    setDbForTests({
      ...db,
      transaction: () => Promise.reject(new Error("database is down")),
    } as Db);
    const res = await score(form(finished.saveToken));
    expect(res.status).toBe(500);
    expect(await bodyOf(res)).toEqual({ error: "server" });
    await afterDone();
    expect(await outcomes()).toEqual(["error"]);
  });

  it("refuses a save the bot check fails, and says so when the check is down", async () => {
    setEnv("TURNSTILE_SECRET", "1x0000000000000000000000000000000AA");
    const finished = await finish(db, GOOD());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ success: false, "error-codes": ["invalid-input-response"] }),
      ),
    );
    expect((await score(form(finished.saveToken, { turnstileToken: "t" }))).status).toBe(400);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 503 })),
    );
    const down = await score(form(finished.saveToken, { turnstileToken: "t" }));
    expect([down.status, await bodyOf(down)]).toEqual([503, { error: "unavailable" }]);
    expect(await db.players.countDocuments()).toBe(0);
    // And with the check passing, the same token still works: nothing was spent.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ success: true })),
    );
    expect((await score(form(finished.saveToken, { turnstileToken: "t" }))).status).toBe(200);
  });
});

describe("POST /api/events (AN-01)", () => {
  const events = (body: unknown, headers?: Record<string, string>) =>
    postEvents(request("/api/events", body, headers));
  const batch = (list: unknown[], extra: Record<string, unknown> = {}) => ({
    sessionId: "session-1234",
    src: "lapresse",
    lang: "fr",
    host: "https://news.example/page",
    events: list,
    ...extra,
  });

  it("stores each known event with its session, placement, language, host and device, and answers 204", async () => {
    const res = await events(
      batch([
        { name: "start", props: { online: true } },
        { name: "milestone", props: { points: 100 } },
      ]),
    );
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    const rows = await db.events.find().sort({ _id: 1 }).toArray();
    expect(rows.map((r) => [r.name, r.props])).toEqual([
      ["start", { online: true }],
      ["milestone", { points: 100 }],
    ]);
    expect(rows[0]).toMatchObject({
      sessionId: "session-1234",
      src: "lapresse",
      lang: "fr",
      device: "mobile",
      hostOrigin: "https://news.example",
    });
  });

  it("drops the events of the old design and any name it doesn't know", async () => {
    await events(
      batch([
        { name: "reward_unlocked", props: { reward: "free_coke" } },
        { name: "claim_view" },
        { name: "claim_success" },
        { name: "api_save", props: { outcome: "ok" } },
        { name: "opt_in" },
        { name: "nope" },
        { name: "save_view" },
      ]),
    );
    // api_save and opt_in are the server's own events: a client can't write them.
    expect((await db.events.find().toArray()).map((e) => e.name)).toEqual(["save_view"]);
  });

  it("keeps at most 8 props, and drops names MongoDB would refuse", async () => {
    const props = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`p${i}`, i]));
    await events(
      batch([{ name: "cta_click", props: { target: "order", $where: 1, "a.b": 2, ...props } }]),
    );
    const [row] = await db.events.find().toArray();
    expect(Object.keys(row.props)).toHaveLength(8);
    expect(row.props).toMatchObject({ target: "order" });
    expect(row.props).not.toHaveProperty("$where");
    expect(row.props).not.toHaveProperty("a.b");
  });

  it("answers 204 and stores nothing for a batch with nothing it knows", async () => {
    expect((await events(batch([{ name: "claim_view" }]))).status).toBe(204);
    expect(await db.events.countDocuments()).toBe(0);
  });

  it("answers 400 to a batch that doesn't fit: no session id, too many events, bad JSON", async () => {
    expect((await events(batch([], { sessionId: "x" }))).status).toBe(400);
    expect(
      (await events(batch(Array.from({ length: 51 }, () => ({ name: "pause" }))))).status,
    ).toBe(400);
    expect((await events("[")).status).toBe(400);
    expect(await db.events.countDocuments()).toBe(0);
  });

  it("answers 429 once an address sends too many batches", async () => {
    setEnv("RATE_LIMITS", "events=1/60");
    const ip = { "x-real-ip": "198.51.100.40" };
    expect((await events(batch([{ name: "pause" }]), ip)).status).toBe(204);
    expect((await events(batch([{ name: "pause" }]), ip)).status).toBe(429);
    expect(await db.events.countDocuments()).toBe(1);
  });
});

describe("cron routes (NFR-08, AN-02, DATA-06)", () => {
  const call = (route: typeof cronAlerts, authorization?: string) =>
    route(request("/api/cron/x", undefined, authorization ? { authorization } : {}));

  it("can be called by hand outside production when no secret is set", async () => {
    setEnv("CRON_SECRET", undefined);
    setEnv("VERCEL_ENV", undefined);
    for (const route of [cronAlerts, cronRollup, cronRetention]) {
      expect((await call(route)).status).toBe(200);
    }
  });

  it("refuse everything in production without a secret, and want the bearer secret with one", async () => {
    setEnv("CRON_SECRET", undefined);
    setEnv("VERCEL_ENV", "production");
    expect((await call(cronAlerts)).status).toBe(401);
    setEnv("CRON_SECRET", "a-cron-secret-0123456789");
    for (const route of [cronAlerts, cronRollup, cronRetention]) {
      const refused = await call(route);
      expect([refused.status, await bodyOf(refused)]).toEqual([401, { error: "unauthorized" }]);
      expect((await call(route, "Bearer wrong-wrong-wrong-wrong")).status).toBe(401);
      expect((await call(route, "Bearer a-cron-secret-0123456789")).status).toBe(200);
    }
  });

  it("alerts: reports the save error rate", async () => {
    setEnv("CRON_SECRET", undefined);
    setEnv("VERCEL_ENV", undefined);
    await db.events.insertMany([
      ...Array.from({ length: 18 }, () => newEvent({ name: "api_save", props: { outcome: "ok" } })),
      ...Array.from({ length: 2 }, () =>
        newEvent({ name: "api_save", props: { outcome: "error" } }),
      ),
    ]);
    expect(await bodyOf(await call(cronAlerts))).toEqual({
      ok: true,
      alerts: [{ name: "saveErrorRate", rate: 0.1, sample: 20, firing: true }],
    });
  });

  it("rollup: recounts the last days into events_daily", async () => {
    setEnv("CRON_SECRET", undefined);
    setEnv("VERCEL_ENV", undefined);
    await db.events.insertMany([
      newEvent({ name: "load", sessionId: "s1" }),
      newEvent({ name: "start", sessionId: "s1" }),
    ]);
    expect(await bodyOf(await call(cronRollup))).toEqual({ ok: true, rows: 2 });
    expect(await db.eventsDaily.countDocuments()).toBe(2);
  });

  it("retention: waits for the end of the contest, then anonymizes everyone but the winners", async () => {
    setEnv("CRON_SECRET", undefined);
    setEnv("VERCEL_ENV", undefined);
    for (let i = 0; i < 5; i++) {
      await addRanked(db, { email: `p${i}@x.ca`, nickname: `p${i}`, points: 100 - i });
    }
    expect(await bodyOf(await call(cronRetention))).toMatchObject({ ok: true, due: false });
    expect(await db.players.countDocuments({ deletedAt: null })).toBe(5);

    // The contest ended long enough ago.
    await db.campaignSettings.updateOne(
      {},
      { $set: { endsAt: new Date(Date.now() - 100 * 86_400_000) } },
    );
    expect(await bodyOf(await call(cronRetention))).toMatchObject({
      ok: true,
      due: true,
      anonymized: 2,
      remaining: 0,
    });
    const kept = await db.players.find({ deletedAt: null }).sort({ nickname: 1 }).toArray();
    expect(kept.map((p) => p.nickname)).toEqual(["p0", "p1", "p2"]);
  });
});
