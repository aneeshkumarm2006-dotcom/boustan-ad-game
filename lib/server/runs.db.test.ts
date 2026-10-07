import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TUNING, distanceMAt, pointsOf } from "@/game-core";
import recorded from "@/game-core/fixtures/recorded-runs.json";
import {
  GOOD,
  SHORT,
  addRanked,
  connect,
  finish,
  honestRun,
  pointsFor,
  resetDb,
  runTokenFor,
  seedCampaign,
  type HonestRun,
} from "@/tests/db";
import { clearCampaignCache } from "./campaign";
import { issuePlayerToken } from "./players";
import { SAVE_WINDOW_MS, finishRun, startRun } from "./runs";
import { hashToken, runTokenSchema, saveTokenSchema, signToken, verifyToken } from "./tokens";

const { db, close } = connect();
afterAll(close);
beforeEach(async () => {
  await resetDb(db);
  await seedCampaign(db);
});

const START = { src: null, lang: "en", utm: {}, host: null } as const;
const finishCtx = (playerToken: string | null = null) => ({
  playerToken,
  clientVersion: null,
  now: new Date(),
});
const body = (r: Pick<HonestRun, "distance" | "garlic" | "hits" | "activeMs">, token: string) => ({
  token,
  distance: r.distance,
  garlic: r.garlic,
  hits: r.hits,
  activeMs: r.activeMs,
});
const rowOf = async (id: string) => (await db.runs.findOne({ _id: id }))!;

/** The answer every failed finish gets, so a forger learns nothing (SEC-03). */
const INVALID = {
  valid: false,
  points: 0,
  saveToken: null,
  best: null,
  rankPreview: null,
  rank: null,
};

/** A player already on the board with `points`, holding a device token: a returning device. */
async function knownDevice(points = 40, email = "known@example.com") {
  const { player } = await addRanked(db, { email, nickname: "Known", points });
  return { player, token: await issuePlayerToken(db, player._id) };
}

/** Finishes a run through the service with a token signed for it; returns the raw outcome. */
async function finishRaw(run: HonestRun, playerToken: string | null = null) {
  const { id, token } = runTokenFor(run);
  return { id, out: await finishRun(db, id, body(run, token), finishCtx(playerToken)) };
}

describe("POST /api/runs/start (SEC-01)", () => {
  it("returns a run id, a seed and a signed token, and writes nothing", async () => {
    const res = await startRun({
      src: "lapresse",
      lang: "fr",
      utm: {},
      host: "https://news.example",
    });
    const token = verifyToken("run", res.token, runTokenSchema);
    expect(token).toMatchObject({
      id: res.runId,
      seed: res.seed,
      src: "lapresse",
      lang: "fr",
      host: "https://news.example",
      tv: TUNING.version,
    });
    expect(await db.runs.countDocuments()).toBe(0);
  });

  it("carries no scoring rules: the server scores a run from the speed curve", async () => {
    const res = await startRun({ ...START, utm: { utm_campaign: "game-2026" } });
    // The schema would drop an unknown field, so read the payload as it was signed.
    const payload = JSON.parse(Buffer.from(res.token.split(".")[0], "base64url").toString());
    expect(Object.keys(payload).sort()).toEqual([
      "host",
      "iat",
      "id",
      "lang",
      "seed",
      "src",
      "tv",
      "utm",
      "v",
    ]);
  });

  it("returns a token the finish endpoint accepts", async () => {
    // Issued 40 s ago, so a 30 s run isn't "too fast".
    const started = await startRun(START, new Date(Date.now() - 40_000));
    const run = honestRun(started.seed, 30, 12, 1);
    const { response } = await finishRun(db, started.runId, body(run, started.token), finishCtx());
    expect(response).toMatchObject({ valid: true, points: pointsFor(run) });
  });

  it("reports the contest window and the leaderboard switch", async () => {
    const settings = (await db.campaignSettings.findOne())!;
    expect((await startRun(START)).campaign).toEqual({
      status: "active",
      startsAt: settings.startsAt!.toISOString(),
      endsAt: settings.endsAt!.toISOString(),
      leaderboardOpen: true,
    });
  });

  it("keeps the game open but flags scores as not counting while the leaderboard is off", async () => {
    await db.campaignSettings.updateOne({}, { $set: { leaderboardOpen: false } });
    clearCampaignCache();
    expect((await startRun(START)).campaign).toMatchObject({
      status: "active",
      leaderboardOpen: false,
    });
  });

  it("reports a contest that hasn't started", async () => {
    const tomorrow = new Date(Date.now() + 86_400_000);
    await db.campaignSettings.updateOne({}, { $set: { startsAt: tomorrow } });
    clearCampaignCache();
    expect((await startRun(START)).campaign).toMatchObject({
      status: "not_started",
      startsAt: tomorrow.toISOString(),
    });
  });

  it("reports an ended contest, and never ends one that has no end date", async () => {
    const later = new Date(Date.now() + 31 * 86_400_000);
    expect((await startRun(START, later)).campaign.status).toBe("ended");
    await db.campaignSettings.updateOne({}, { $set: { endsAt: null } });
    clearCampaignCache();
    expect((await startRun(START, later)).campaign).toMatchObject({
      status: "active",
      endsAt: null,
    });
  });

  it("treats a missing settings document as a closed leaderboard", async () => {
    await db.campaignSettings.deleteMany({});
    clearCampaignCache();
    expect((await startRun(START)).campaign).toEqual({
      status: "active",
      startsAt: null,
      endsAt: null,
      leaderboardOpen: false,
    });
  });
});

describe("POST /api/runs/:id/finish: scoring (SEC-02)", () => {
  it("accepts every recorded real run and scores it from the speed curve", async () => {
    for (const run of recorded.runs) {
      const { id, out } = await finishRaw(run);
      expect(out.response.valid, run.scenario).toBe(true);
      const row = await rowOf(id);
      expect(row).toMatchObject({ status: "valid", src: "test-src", flagReason: null });
      expect(row.utm).toEqual({ utm_campaign: "test" });
      expect(row.points).toBe(
        pointsOf({ distanceM: distanceMAt(run.activeMs), garlic: run.garlic }),
      );
    }
  });

  it("scores a run on the server: whole metres of the curve plus 10 per garlic", async () => {
    const run = GOOD();
    const res = await finish(db, run);
    expect(res.valid).toBe(true);
    expect(res.points).toBe(Math.floor(distanceMAt(run.activeMs)) + 10 * run.garlic);
    expect(res.points).toBe(pointsFor(run));
    expect(await rowOf(res.runId)).toMatchObject({
      status: "valid",
      points: res.points,
      garlic: run.garlic,
      hits: run.hits,
      activeMs: run.activeMs,
      flagReason: null,
    });
  });

  it("ignores a slightly different reported distance and stores the server's", async () => {
    for (const factor of [1.015, 0.985]) {
      const run = GOOD();
      const reported = { ...run, distance: run.distance * factor };
      // The test only means something if the reported distance would have scored differently.
      expect(pointsOf({ distanceM: reported.distance, garlic: run.garlic })).not.toBe(
        pointsFor(run),
      );
      const { id, token } = runTokenFor(run);
      const { response, flag } = await finishRun(db, id, body(reported, token), finishCtx());
      expect(flag).toBeNull();
      expect(response).toMatchObject({ valid: true, points: pointsFor(run) });
      expect((await rowOf(id)).distanceM).toBe(distanceMAt(run.activeMs));
    }
  });

  it("writes the run once, with its source, host, language and client version", async () => {
    const run = SHORT();
    const { id, token } = runTokenFor(run);
    await finishRun(db, id, body(run, token), { ...finishCtx(), clientVersion: "abc123" });
    expect(await db.runs.countDocuments()).toBe(1);
    expect(await rowOf(id)).toMatchObject({
      seed: run.seed,
      src: "test-src",
      hostOrigin: "https://host.example",
      language: "fr",
      tuningVersion: TUNING.version,
      clientVersion: "abc123",
      playerId: null,
      savedAt: null,
    });
  });
});

describe("POST /api/runs/:id/finish: forged runs (SEC-03, AC-05)", () => {
  const tooFar = GOOD().distance * 1.05;
  const tooShort = GOOD().distance * 0.95;

  it.each([
    ["a distance above the curve", "distance", { distance: tooFar }],
    ["a distance below the curve", "distance", { distance: tooShort }],
    ["more garlic than spawned", "garlic", { garlic: 500 }],
    ["more hits than obstacles spawned", "hits", { hits: 900 }],
    ["a fractional garlic count", "bad_input", { garlic: 1.5 }],
    ["a negative distance", "bad_input", { distance: -1 }],
  ] as const)("flags %s", async (_, reason, patch) => {
    const run = { ...GOOD(), ...patch };
    const { id, out } = await finishRaw(run);
    expect(out.response).toEqual(INVALID);
    expect(out.flag).toBe(reason);
    expect(await rowOf(id)).toMatchObject({
      status: "flagged",
      flagReason: reason,
      points: 0,
      savedAt: null,
    });
    expect(await db.bestRuns.countDocuments()).toBe(0);
  });

  it("keeps what a flagged run claimed, for the admin to look at, and awards nothing for it", async () => {
    const { id } = await finishRaw({ ...GOOD(), distance: tooFar });
    expect(await rowOf(id)).toMatchObject({ distanceM: tooFar, points: 0, status: "flagged" });
  });

  it("flags a run longer than the time since its token", async () => {
    const run = GOOD();
    const { id, token } = runTokenFor(run, { issuedAt: Date.now() - 5000 });
    const out = await finishRun(db, id, body(run, token), finishCtx());
    expect(out.response).toEqual(INVALID);
    expect(await rowOf(id)).toMatchObject({ status: "flagged", flagReason: "too_fast" });
  });

  it("flags an expired token", async () => {
    const run = GOOD();
    const { id, token } = runTokenFor(run, { issuedAt: Date.now() - 3 * 3_600_000 });
    const out = await finishRun(db, id, body(run, token), finishCtx());
    expect(out.response).toEqual(INVALID);
    expect(await rowOf(id)).toMatchObject({ status: "flagged", flagReason: "expired", points: 0 });
  });

  it("flags a token issued under another tuning version", async () => {
    const run = GOOD();
    const id = randomUUID();
    const token = signToken("run", {
      v: 1,
      id,
      seed: run.seed,
      iat: Date.now() - run.activeMs - 2000,
      tv: TUNING.version + 1,
      lang: "fr",
      src: null,
      host: null,
      utm: {},
    });
    const out = await finishRun(db, id, body(run, token), finishCtx());
    expect(out.response).toEqual(INVALID);
    expect(await rowOf(id)).toMatchObject({ status: "flagged", flagReason: "version", points: 0 });
  });

  it("gives a known device no rank, no best and no save for a flagged run", async () => {
    const { player, token } = await knownDevice(40);
    const before = await db.bestRuns.findOne({ _id: player._id });
    const { id, out } = await finishRaw({ ...GOOD(), garlic: 500 }, token);
    expect(out.response).toEqual(INVALID);
    expect(await db.bestRuns.findOne({ _id: player._id })).toEqual(before);
    expect(await rowOf(id)).toMatchObject({ status: "flagged", points: 0, savedAt: null });
  });

  it("never gives an unknown device a save token for a flagged run", async () => {
    const { out } = await finishRaw({ ...GOOD(), hits: 900 });
    expect(out.response.saveToken).toBeNull();
    expect(await db.bestRuns.countDocuments()).toBe(0);
  });

  it("refuses a reused token without touching the first run", async () => {
    const run = GOOD();
    const { id, token } = runTokenFor(run);
    expect((await finishRun(db, id, body(run, token), finishCtx())).response.valid).toBe(true);
    const again = await finishRun(db, id, body({ ...run, garlic: 0 }, token), finishCtx());
    expect(again).toEqual({ response: INVALID, flag: "reused" });
    expect(await rowOf(id)).toMatchObject({ status: "valid", garlic: run.garlic });
  });

  it("accepts a token once even when it is submitted many times at once", async () => {
    const run = GOOD();
    const { id, token } = runTokenFor(run);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => finishRun(db, id, body(run, token), finishCtx())),
    );
    expect(results.filter((r) => r.response.valid)).toHaveLength(1);
    expect(results.filter((r) => r.flag === "reused")).toHaveLength(9);
    expect(await db.runs.countDocuments({ _id: id })).toBe(1);
  });

  it("refuses a bad signature, a token for another run or one of another kind, writing nothing", async () => {
    const run = GOOD();
    const { id, token } = runTokenFor(run);
    const tampered = `${token.slice(0, -3)}AAA`;
    expect((await finishRun(db, id, body(run, tampered), finishCtx())).flag).toBe("bad_token");
    expect((await finishRun(db, randomUUID(), body(run, token), finishCtx())).flag).toBe(
      "run_mismatch",
    );
    const asSave = signToken("save", { v: 1, run: id, exp: Date.now() + 60_000 });
    expect((await finishRun(db, id, body(run, asSave), finishCtx())).flag).toBe("bad_token");
    expect(await db.runs.countDocuments()).toBe(0);
  });
});

describe("POST /api/runs/:id/finish: a known device (DATA-01, LB-02, LB-03)", () => {
  it("saves its best run as the run finishes and returns the rank, with no save token", async () => {
    await addRanked(db, { email: "top@example.com", nickname: "Top", points: 900 });
    await addRanked(db, { email: "low@example.com", nickname: "Low", points: 5 });
    const { player, token } = await knownDevice(100);
    const run = GOOD();

    const res = await finish(db, run, token);
    expect(res).toMatchObject({ valid: true, points: pointsFor(run), saveToken: null, rank: 2 });
    expect(res.best).toEqual({
      points: pointsFor(run),
      distanceM: distanceMAt(run.activeMs),
      garlic: run.garlic,
    });
    // The preview leaves the player's own row out, so it agrees with the rank.
    expect(res.rankPreview).toBe(2);

    const row = await rowOf(res.runId);
    expect(row).toMatchObject({ playerId: player._id, status: "valid" });
    expect(row.savedAt).toBeInstanceOf(Date);
    expect(await db.bestRuns.findOne({ _id: player._id })).toMatchObject({
      runId: res.runId,
      points: pointsFor(run),
    });
  });

  it("replaces the best run only when a strictly better one finishes", async () => {
    const { player, token } = await knownDevice(10);
    const stored = async () => (await db.bestRuns.findOne({ _id: player._id }))!;

    const first = await finish(db, GOOD(1), token);
    expect((await stored()).runId).toBe(first.runId);
    const achieved = (await stored()).achievedAt;

    // Worse, then equal: the first run stays, and so does its time (it got there first).
    const worse = await finish(db, SHORT(), token);
    expect(worse.best).toMatchObject({ points: pointsFor(GOOD(1)) });
    const equal = await finish(db, GOOD(2), token);
    expect(pointsFor(GOOD(2))).toBe(pointsFor(GOOD(1)));
    expect(equal.best).toMatchObject({ points: pointsFor(GOOD(1)) });
    expect(await stored()).toMatchObject({ runId: first.runId, achievedAt: achieved });

    const better = await finish(db, honestRun(3, 40, 12, 1), token);
    expect(better.points).toBeGreaterThan(first.points);
    expect((await stored()).runId).toBe(better.runId);
    expect(better.rank).toBe(1);
    expect(await db.bestRuns.countDocuments({ _id: player._id })).toBe(1);
  });

  it("keeps the best of many runs that finish at the same moment", async () => {
    const { player, token } = await knownDevice(1);
    const runs = Array.from({ length: 12 }, (_, i) => honestRun(20 + i, 5 + i, i % 4));
    await Promise.all(runs.map((r) => finish(db, r, token)));
    const best = Math.max(...runs.map(pointsFor));
    expect(await db.bestRuns.find({ _id: player._id }).toArray()).toEqual([
      expect.objectContaining({ points: best }),
    ]);
  });

  it("returns no rank for a hidden player, but still keeps their best run", async () => {
    const { player } = await addRanked(db, {
      email: "hidden@example.com",
      nickname: "Hidden",
      points: 10,
      hidden: true,
    });
    const token = await issuePlayerToken(db, player._id);
    const res = await finish(db, GOOD(), token);
    expect(res).toMatchObject({ valid: true, rank: null, saveToken: null });
    expect(res.best).toMatchObject({ points: pointsFor(GOOD()) });
    expect(await db.bestRuns.findOne({ _id: player._id })).toMatchObject({ runId: res.runId });
  });

  it("treats an unknown, forged or erased device token as a new device", async () => {
    const { player, token } = await knownDevice(40);
    for (const unknown of ["not-a-real-token", `${token}x`, "x".repeat(300)]) {
      const res = await finish(db, GOOD(), unknown);
      expect(res).toMatchObject({ valid: true, best: null, rank: null });
      expect(res.saveToken).toBeTruthy();
    }
    await db.players.updateOne({ _id: player._id }, { $set: { deletedAt: new Date() } });
    const erased = await finish(db, GOOD(), token);
    expect(erased.saveToken).toBeTruthy();
    expect(erased.rank).toBeNull();
    expect(await db.bestRuns.findOne({ _id: player._id })).toMatchObject({ points: 40 });
  });

  it("stamps the device token as used", async () => {
    const { token } = await knownDevice();
    const hash = hashToken(token);
    const old = new Date(Date.now() - 86_400_000);
    await db.playerTokens.updateOne({ _id: hash }, { $set: { lastUsedAt: old } });
    await finish(db, SHORT(), token);
    // The stamp is written after the response, without waiting for it.
    await vi.waitFor(async () => {
      const row = await db.playerTokens.findOne({ _id: hash });
      expect(row!.lastUsedAt.getTime()).toBeGreaterThan(old.getTime());
    });
  });
});

describe("POST /api/runs/:id/finish: an unknown device (SEC-04)", () => {
  it("gets a save token valid for 30 minutes, and nothing lands on the board", async () => {
    const res = await finish(db, GOOD());
    expect(res.valid).toBe(true);
    const save = verifyToken("save", res.saveToken!, saveTokenSchema)!;
    expect(save.run).toBe(res.runId);
    expect(save.exp - Date.now()).toBeGreaterThan(SAVE_WINDOW_MS - 5000);
    expect(save.exp - Date.now()).toBeLessThanOrEqual(SAVE_WINDOW_MS);
    expect(res).toMatchObject({ best: null, rank: null, rankPreview: 1 });
    expect(await db.bestRuns.countDocuments()).toBe(0);
    expect((await rowOf(res.runId)).savedAt).toBeNull();
  });

  it("gets a save token even for a short run: any valid run can be saved", async () => {
    const res = await finish(db, honestRun(5, 1));
    expect(res).toMatchObject({ valid: true, points: pointsFor(honestRun(5, 1)) });
    expect(res.saveToken).toBeTruthy();
  });

  it("previews the rank the run would take, with equal scores staying ahead", async () => {
    const run = GOOD();
    const points = pointsFor(run);
    await addRanked(db, { email: "a@example.com", nickname: "A", points: points + 50 });
    await addRanked(db, { email: "b@example.com", nickname: "B", points });
    await addRanked(db, { email: "c@example.com", nickname: "C", points: points - 1 });
    expect((await finish(db, run)).rankPreview).toBe(3);
  });
});

describe("POST /api/runs/:id/finish: when the contest isn't open (SEC-08)", () => {
  const closings = [
    ["the leaderboard is switched off", { leaderboardOpen: false }],
    ["the contest hasn't started", { startsAt: new Date(Date.now() + 86_400_000) }],
    ["the contest has ended", { endsAt: new Date(Date.now() - 1000) }],
  ] as const;

  it.each(closings)(
    "scores a valid run but doesn't save, rank or preview it when %s",
    async (_, patch) => {
      await db.campaignSettings.updateOne({}, { $set: patch });
      clearCampaignCache();
      const run = GOOD();
      const res = await finish(db, run);
      expect(res).toMatchObject({
        valid: true,
        points: pointsFor(run),
        saveToken: null,
        best: null,
        rankPreview: null,
        rank: null,
      });
      expect(await db.bestRuns.countDocuments()).toBe(0);
      expect((await rowOf(res.runId)).status).toBe("valid");
    },
  );

  it.each(closings)("leaves a known device's best run alone when %s", async (_, patch) => {
    const { player, token } = await knownDevice(40);
    await db.campaignSettings.updateOne({}, { $set: patch });
    clearCampaignCache();
    const run = GOOD();
    const res = await finish(db, run, token);
    expect(res).toMatchObject({
      valid: true,
      points: pointsFor(run),
      saveToken: null,
      rankPreview: null,
      rank: 1,
    });
    expect(res.best).toMatchObject({ points: 40 });
    expect(await db.bestRuns.findOne({ _id: player._id })).toMatchObject({ points: 40 });
    expect((await rowOf(res.runId)).savedAt).toBeNull();
  });
});
