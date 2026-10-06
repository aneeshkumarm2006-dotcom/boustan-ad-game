import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { campaignSettings, rewards, runs } from "@/db/schema";
import { distanceMAt } from "@/game-core";
import recorded from "@/game-core/fixtures/recorded-runs.json";
import { BOTH, NOTHING, connect, finish, resetDb, runTokenFor, seedCampaign } from "@/tests/db";
import { clearCampaignCache } from "./campaign";
import { finishRun, startRun } from "./runs";
import { claimTokenSchema, runTokenSchema, verifyToken } from "./tokens";

const { db, close } = connect();
afterAll(close);
beforeEach(async () => {
  await resetDb(db);
  await seedCampaign(db);
});

const now = () => new Date();
const body = (
  r: { distance: number; garlic: number; hits: number; activeMs: number },
  token: string,
) => ({
  token,
  distance: r.distance,
  garlic: r.garlic,
  hits: r.hits,
  activeMs: r.activeMs,
});
const rowOf = async (id: string) => (await db.select().from(runs).where(eq(runs.id, id)))[0];

describe("POST /api/runs/start (SEC-01)", () => {
  it("returns a run id, a seed and a signed token, and writes nothing", async () => {
    const res = await startRun({
      src: "lapresse",
      lang: "fr",
      utm: {},
      host: "https://news.example",
    });
    const token = verifyToken("run", res.token, runTokenSchema);
    expect(token).toMatchObject({ id: res.runId, seed: res.seed, src: "lapresse", lang: "fr" });
    expect(token!.rules).toEqual({ distanceM: 100, garlic: 10 });
    expect(await db.select().from(runs)).toHaveLength(0);
    expect(res.campaign).toMatchObject({
      status: "active",
      claimsEnabled: true,
      rewards: { free_coke: { available: true }, free_garlic_sauce: { available: true } },
    });
  });

  it("reports the campaign window, kill switches and sold-out rewards (§3.4)", async () => {
    await db
      .update(campaignSettings)
      .set({ claimsEnabled: false, startsAt: new Date(Date.now() + 86_400_000) });
    await db.update(rewards).set({ active: false }).where(eq(rewards.id, "free_garlic_sauce"));
    clearCampaignCache();
    const res = await startRun({ src: null, lang: "en", utm: {}, host: null });
    expect(res.campaign.status).toBe("not_started");
    expect(res.campaign.claimsEnabled).toBe(false);
    expect(res.campaign.rewards.free_garlic_sauce).toEqual({ available: false, reason: "paused" });
  });

  it("carries changed thresholds in new tokens only (ADM-07)", async () => {
    await db
      .update(rewards)
      .set({ rule: { distanceM: 150 } })
      .where(eq(rewards.id, "free_coke"));
    clearCampaignCache();
    const res = await startRun({ src: null, lang: "en", utm: {}, host: null });
    expect(verifyToken("run", res.token, runTokenSchema)!.rules.distanceM).toBe(150);
    expect(res.campaign.rules.free_coke.distanceM).toBe(150);
  });
});

describe("POST /api/runs/:id/finish (SEC-02 to SEC-04)", () => {
  it("accepts every recorded real run and writes it as valid", async () => {
    for (const run of recorded.runs) {
      const { id, token } = runTokenFor(run);
      const { response } = await finishRun(db, id, body(run, token), {
        playerToken: null,
        clientVersion: "abc123",
        now: now(),
      });
      expect(response.valid, run.scenario).toBe(true);
      const row = await rowOf(id);
      expect(row).toMatchObject({ status: "valid", src: "test-src", clientVersion: "abc123" });
      expect(row.utm).toEqual({ utm_campaign: "test" });
    }
  });

  it("unlocks rewards and returns a 30-minute claim token (RWD-08)", async () => {
    const res = await finish(db, BOTH());
    expect(res.valid).toBe(true);
    expect(res.unlocked).toEqual(["free_coke", "free_garlic_sauce"]);
    const claim = verifyToken("claim", res.claimToken!, claimTokenSchema)!;
    expect(claim.run).toBe(res.runId);
    expect(claim.exp - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(claim.exp - Date.now()).toBeLessThanOrEqual(30 * 60_000);
    expect(res.rankPreview).toBe(1);
  });

  it("issues a claim token with nothing unlocked, for Save my score (§15.3)", async () => {
    const res = await finish(db, NOTHING());
    expect(res).toMatchObject({ valid: true, unlocked: [] });
    expect(res.claimToken).toBeTruthy();
  });

  it("unlocks nothing while claims are off or the reward is paused", async () => {
    await db.update(rewards).set({ active: false }).where(eq(rewards.id, "free_coke"));
    clearCampaignCache();
    expect((await finish(db, BOTH())).unlocked).toEqual(["free_garlic_sauce"]);
    await db.update(campaignSettings).set({ claimsEnabled: false });
    clearCampaignCache();
    expect((await finish(db, BOTH())).unlocked).toEqual([]);
  });

  describe("forged runs get no reward and no claim token (AC-05)", () => {
    const INVALID = {
      valid: false,
      unlocked: [],
      claimToken: null,
      best: null,
      rankPreview: null,
      rank: null,
    };

    it.each([
      ["distance", { distance: distanceMAt(30_000) * 1.05 }],
      ["garlic", { garlic: 500 }],
      ["hits", { hits: 900 }],
    ])("flags a run with an impossible %s", async (reason, patch) => {
      const run = { ...BOTH(), ...patch };
      const { id, token } = runTokenFor(run);
      const out = await finishRun(db, id, body(run, token), {
        playerToken: null,
        clientVersion: null,
        now: now(),
      });
      expect(out.response).toEqual(INVALID);
      expect(await rowOf(id)).toMatchObject({ status: "flagged", flagReason: reason });
    });

    it("flags a run longer than the time since its token", async () => {
      const run = BOTH();
      const { id, token } = runTokenFor(run, { issuedAt: Date.now() - 5000 });
      const out = await finishRun(db, id, body(run, token), {
        playerToken: null,
        clientVersion: null,
        now: now(),
      });
      expect(out.response).toEqual(INVALID);
      expect(await rowOf(id)).toMatchObject({ status: "flagged", flagReason: "too_fast" });
    });

    it("flags an expired token", async () => {
      const run = BOTH();
      const { id, token } = runTokenFor(run, { issuedAt: Date.now() - 3 * 3_600_000 });
      const out = await finishRun(db, id, body(run, token), {
        playerToken: null,
        clientVersion: null,
        now: now(),
      });
      expect(out.response).toEqual(INVALID);
      expect(await rowOf(id)).toMatchObject({ status: "flagged", flagReason: "expired" });
    });

    it("refuses a reused token without touching the first run", async () => {
      const run = BOTH();
      const { id, token } = runTokenFor(run);
      const ctx = { playerToken: null, clientVersion: null, now: now() };
      expect((await finishRun(db, id, body(run, token), ctx)).response.valid).toBe(true);
      const again = await finishRun(db, id, body({ ...run, garlic: 0 }, token), ctx);
      expect(again).toEqual({ response: INVALID, flag: "reused" });
      expect(await rowOf(id)).toMatchObject({ status: "valid", garlic: run.garlic });
    });

    it("refuses a bad signature or a token for another run, writing nothing", async () => {
      const run = BOTH();
      const { id, token } = runTokenFor(run);
      const ctx = { playerToken: null, clientVersion: null, now: now() };
      const tampered = `${token.slice(0, -3)}AAA`;
      expect((await finishRun(db, id, body(run, tampered), ctx)).flag).toBe("bad_token");
      const other = randomUUID();
      expect((await finishRun(db, other, body(run, token), ctx)).flag).toBe("run_mismatch");
      expect(await db.select().from(runs)).toHaveLength(0);
    });
  });
});
