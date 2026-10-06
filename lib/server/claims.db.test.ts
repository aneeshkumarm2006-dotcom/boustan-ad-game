import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { newClaim, newCode } from "@/db/schema";
import { BOTH, NOTHING, connect, ctx, finish, honestRun, resetDb, seedCampaign } from "@/tests/db";
import { claimRewards, type ClaimInput } from "./claims";
import { signToken } from "./tokens";

const { db, close } = connect(40);
afterAll(close);
beforeEach(async () => {
  await resetDb(db);
  await seedCampaign(db);
});

const form = (claimToken: string, email: string, extra: Partial<ClaimInput> = {}): ClaimInput => ({
  claimToken,
  email,
  lang: "fr",
  termsAge: true,
  marketingOptIn: false,
  src: "lapresse",
  utm: { utm_campaign: "game-2026" },
  ...extra,
});
const oneTap = (claimToken: string, playerToken: string): ClaimInput => ({
  claimToken,
  playerToken,
  lang: "fr",
  termsAge: true,
  marketingOptIn: false,
  src: null,
  utm: {},
});

async function claimOk(input: ClaimInput) {
  const res = await claimRewards(db, input, ctx());
  if (!res.ok) throw new Error(`claim failed: ${res.error}`);
  return res;
}

describe("POST /api/claim", () => {
  it("issues one code per unlocked reward, in one transaction with email and CRM rows (AC-02)", async () => {
    const run = await finish(db, BOTH());
    const res = await claimOk(
      form(run.claimToken!, "Alex.Tremblay+jeu@gmail.com", { nickname: "Toum Fan" }),
    );
    const r = res.response;
    expect(r.codes.map((c) => c.reward)).toEqual(["free_coke", "free_garlic_sauce"]);
    expect(new Set(r.codes.map((c) => c.code)).size).toBe(2);
    expect(r.alreadyClaimed).toEqual([]);
    expect(r.unavailable).toEqual([]);
    expect(r.rank).toBe(1);
    expect(r.playerToken).toMatch(/^[\w-]{43}$/);
    const expiry = new Date(r.codes[0].expiresAt).getTime() - Date.now();
    expect(Math.round(expiry / 86_400_000)).toBe(30);

    const player = (await db.players.findOne())!;
    expect(player).toMatchObject({
      email: "Alex.Tremblay+jeu@gmail.com",
      emailNormalized: "alextremblay@gmail.com",
      nickname: "Toum Fan",
      language: "fr",
      firstSrc: "test-src",
      firstHost: "https://host.example",
      marketingOptIn: false,
    });
    expect(player.ageConfirmedAt).not.toBeNull();

    const issued = await db.codes.find({ status: "assigned" }).toArray();
    expect(issued).toHaveLength(2);
    const claimRows = await db.claims.find().toArray();
    expect(claimRows.every((c) => c.codeId && c.src === "lapresse" && c.runId === run.runId)).toBe(
      true,
    );

    const email = (await db.emailOutbox.findOne())!;
    expect(email).toMatchObject({ kind: "coupon", status: "pending", language: "fr" });
    expect([...email.claimIds].sort()).toEqual(claimRows.map((c) => c._id).sort());
    expect(res.emailId).toBe(email._id);

    const crm = await db.crmOutbox.find().toArray();
    expect(crm.map((c) => c.type).sort()).toEqual(["contact_upsert", "reward_claimed"]);

    const spent = (await db.runs.findOne({ _id: run.runId }))!;
    expect(spent.claimedAt).not.toBeNull();
    expect(spent.playerId).toBe(player._id);
  });

  it("records consent with its text, version, language, IP and host (DATA-03, AC-07)", async () => {
    const run = await finish(db, BOTH());
    await claimOk(form(run.claimToken!, "opt@in.ca", { marketingOptIn: true, lang: "en" }));
    const rows = await db.consents.find().sort({ _id: 1 }).toArray();
    expect(rows.map((c) => [c.kind, c.granted])).toEqual([
      ["terms_age", true],
      ["marketing", true],
    ]);
    expect(rows[0]).toMatchObject({
      text: "I'm 14 or older and I accept the offer terms and the privacy policy.",
      textVersion: "en-2026-10-06-draft",
      language: "en",
      source: "claim_form",
      ip: "203.0.113.7",
      userAgent: "vitest",
      hostOrigin: "https://host.example",
    });
    const player = (await db.players.findOne())!;
    expect(player.marketingOptIn).toBe(true);
    expect((await db.crmOutbox.find().toArray()).some((c) => c.type === "consent_changed")).toBe(
      true,
    );
  });

  it("never treats an unticked opt-in as a withdrawal", async () => {
    const first = await finish(db, BOTH());
    await claimOk(form(first.claimToken!, "keep@in.ca", { marketingOptIn: true }));
    const second = await finish(db, NOTHING());
    await claimOk(form(second.claimToken!, "keep@in.ca", { marketingOptIn: false }));
    const player = (await db.players.findOne())!;
    expect(player.marketingOptIn).toBe(true);
    const marketing = await db.consents.find({ kind: "marketing" }).toArray();
    expect(marketing).toHaveLength(1);
  });

  it("gives no new code to the same person, Gmail variants included, and re-sends (AC-03)", async () => {
    const first = await finish(db, BOTH());
    const original = await claimOk(form(first.claimToken!, "sam.roy@gmail.com"));
    const second = await finish(db, BOTH(11));
    const again = await claimOk(form(second.claimToken!, "SamRoy+again@googlemail.com"));
    expect(again.response.codes).toEqual([]);
    expect(again.response.alreadyClaimed).toEqual(["free_coke", "free_garlic_sauce"]);
    expect(again.alreadyClaimIds.sort()).toEqual(
      (await db.claims.find().toArray()).map((c) => c._id).sort(),
    );
    expect(again.playerId).toBe(original.playerId);
    expect(await db.players.find().toArray()).toHaveLength(1);
    expect(await db.codes.find({ status: "assigned" }).toArray()).toHaveLength(2);
    // The address on file is the one first typed (MAIL-08).
    expect((await db.players.findOne())!.email).toBe("sam.roy@gmail.com");
  });

  it("recognizes a returning device for a one-tap claim (DATA-01, §3.3)", async () => {
    const first = await finish(db, honestRun(3, 30, 0));
    const res = await claimOk(form(first.claimToken!, "jo@videotron.ca"));
    expect(res.response.codes.map((c) => c.reward)).toEqual(["free_coke"]);
    const token = res.response.playerToken;

    const second = await finish(db, honestRun(4, 26, 11), token);
    expect(second.unlocked).toEqual(["free_coke", "free_garlic_sauce"]);
    expect(second.best!.garlic).toBeGreaterThanOrEqual(10);
    // The best score is the three numbers, nothing else of the stored row.
    expect(Object.keys(second.best!).sort()).toEqual(["distanceM", "garlic", "hits"]);
    const tap = await claimOk(oneTap(second.claimToken!, token));
    expect(tap.response.codes.map((c) => c.reward)).toEqual(["free_garlic_sauce"]);
    expect(tap.response.alreadyClaimed).toEqual(["free_coke"]);
    expect(tap.response.playerToken).toBe(token);
    // One-tap shows no form, so it records no new consent.
    expect(await db.consents.find().toArray()).toHaveLength(1);
  });

  it("refuses an unknown device token so the form can ask again", async () => {
    const run = await finish(db, BOTH());
    expect(await claimRewards(db, oneTap(run.claimToken!, "not-a-real-token"), ctx())).toEqual({
      ok: false,
      error: "unknown_player",
    });
  });

  it("saves a score when nothing was unlocked (§15.3, LB-03)", async () => {
    const run = await finish(db, NOTHING());
    const res = await claimOk(form(run.claimToken!, "score@only.ca"));
    expect(res.response).toMatchObject({ codes: [], alreadyClaimed: [], unavailable: [], rank: 1 });
    expect(res.emailId).toBeNull();
    const best = (await db.bestRuns.findOne())!;
    expect(best).toMatchObject({ runId: run.runId, garlic: NOTHING().garlic });
    expect(await db.emailOutbox.find().toArray()).toHaveLength(0);
  });

  it("says All gone when the pool is empty, and doesn't half-claim (RWD-04)", async () => {
    await db.codes.deleteMany({ rewardId: "free_coke" });
    const run = await finish(db, BOTH());
    const res = await claimOk(form(run.claimToken!, "late@comer.ca"));
    expect(res.response.codes.map((c) => c.reward)).toEqual(["free_garlic_sauce"]);
    expect(res.response.unavailable).toEqual(["free_coke"]);
    const rows = await db.claims.find().toArray();
    expect(rows.map((c) => c.rewardId)).toEqual(["free_garlic_sauce"]);
  });

  it("honours the kill switches at claim time (SEC-08)", async () => {
    const run = await finish(db, BOTH());
    await db.rewards.updateOne({ _id: "free_garlic_sauce" }, { $set: { active: false } });
    const res = await claimOk(form(run.claimToken!, "switch@test.ca"));
    expect(res.response.codes.map((c) => c.reward)).toEqual(["free_coke"]);
    expect(res.response.unavailable).toEqual(["free_garlic_sauce"]);

    const run2 = await finish(db, BOTH(12));
    await db.campaignSettings.updateOne({}, { $set: { claimsEnabled: false } });
    const res2 = await claimOk(form(run2.claimToken!, "switch2@test.ca"));
    expect(res2.response.codes).toEqual([]);
    expect(res2.response.unavailable).toEqual(["free_coke", "free_garlic_sauce"]);
  });

  it("uses each claim token once; a retry by the same player gets the same codes", async () => {
    const run = await finish(db, BOTH());
    const first = await claimOk(form(run.claimToken!, "retry@test.ca"));
    const retry = await claimOk(form(run.claimToken!, "retry@test.ca"));
    expect(retry.response.codes).toEqual(first.response.codes);
    expect(retry.emailId).toBeNull();
    expect(await claimRewards(db, form(run.claimToken!, "thief@test.ca"), ctx())).toEqual({
      ok: false,
      error: "expired",
    });
  });

  it("refuses expired, forged and flagged-run claim tokens (SEC-04)", async () => {
    const run = await finish(db, BOTH());
    const expired = signToken("claim", { v: 1, run: run.runId, exp: Date.now() - 1 });
    expect(await claimRewards(db, form(expired, "a@test.ca"), ctx())).toEqual({
      ok: false,
      error: "expired",
    });
    expect(await claimRewards(db, form(`${run.claimToken}x`, "a@test.ca"), ctx())).toEqual({
      ok: false,
      error: "rejected",
    });
    await db.runs.updateOne({ _id: run.runId }, { $set: { status: "flagged" } });
    expect(await claimRewards(db, form(run.claimToken!, "a@test.ca"), ctx())).toEqual({
      ok: false,
      error: "rejected",
    });
  });

  it("refuses disposable addresses and claims without the terms box (DATA-04)", async () => {
    const run = await finish(db, BOTH());
    expect(await claimRewards(db, form(run.claimToken!, "x@mailinator.com"), ctx())).toEqual({
      ok: false,
      error: "bad_email",
    });
    expect(
      await claimRewards(db, form(run.claimToken!, "x@ok.ca", { termsAge: false }), ctx()),
    ).toEqual({ ok: false, error: "rejected" });
    expect(await db.players.find().toArray()).toHaveLength(0);
  });

  it("enforces one claim per player per reward, and one claim per code, in the database (SEC-07)", async () => {
    const run = await finish(db, BOTH());
    const res = await claimOk(form(run.claimToken!, "unique@test.ca"));
    await expect(
      db.claims.insertOne(
        newClaim({
          playerId: res.playerId,
          rewardId: "free_coke",
          runId: run.runId,
          language: "fr",
        }),
      ),
    ).rejects.toThrow(/duplicate key/);
    await expect(
      db.codes.insertOne(newCode({ rewardId: "free_coke", code: res.response.codes[0].code })),
    ).rejects.toThrow(/duplicate key/);

    // Another player's claim can't take a code that already backs one.
    const taken = (await db.claims.findOne({ rewardId: "free_coke" }))!;
    await expect(
      db.claims.insertOne(
        newClaim({
          playerId: randomUUID(),
          rewardId: "free_coke",
          runId: run.runId,
          language: "fr",
          codeId: taken.codeId,
        }),
      ),
    ).rejects.toThrow(/duplicate key/);

    // Claims that don't hold a code yet are not in that index, so any number can coexist.
    for (let i = 0; i < 2; i++) {
      await db.claims.insertOne(
        newClaim({
          playerId: randomUUID(),
          rewardId: "free_coke",
          runId: run.runId,
          language: "fr",
        }),
      );
    }
  });
});

describe("code assignment under load (RWD-03, AC-04)", () => {
  it("gives 200 simultaneous claims on a 100-code pool exactly 100 distinct codes", async () => {
    await resetDb(db);
    await seedCampaign(db, { codesPerReward: 0 });
    await db.codes.insertMany(
      Array.from({ length: 100 }, (_, i) =>
        newCode({ rewardId: "free_coke", code: `LOAD-${String(i + 1).padStart(4, "0")}` }),
      ),
    );
    const runs200 = await Promise.all(
      Array.from({ length: 200 }, (_, i) => finish(db, honestRun(1000 + i, 25, 0))),
    );
    expect(runs200.every((r) => r.unlocked.includes("free_coke"))).toBe(true);

    const results = await Promise.all(
      runs200.map((r, i) => claimRewards(db, form(r.claimToken!, `player${i}@load.test`), ctx())),
    );
    const ok = results.filter((r) => r.ok);
    expect(ok).toHaveLength(200);
    const issued = ok.flatMap((r) => r.response.codes.map((c) => c.code));
    expect(issued).toHaveLength(100);
    expect(new Set(issued).size).toBe(100);
    expect(ok.filter((r) => r.response.unavailable.includes("free_coke"))).toHaveLength(100);

    expect({
      assigned: await db.codes.countDocuments({ status: "assigned" }),
      available: await db.codes.countDocuments({ status: "available" }),
    }).toEqual({ assigned: 100, available: 0 });
    const claimed = await db.claims.find({ rewardId: "free_coke" }).toArray();
    expect(claimed).toHaveLength(100);
    expect(new Set(claimed.map((c) => String(c.codeId))).size).toBe(100);
  });

  it("gives one player claiming the same run twice at once a single set of codes", async () => {
    const run = await finish(db, BOTH());
    const [a, b] = await Promise.all([
      claimRewards(db, form(run.claimToken!, "twice@test.ca"), ctx()),
      claimRewards(db, form(run.claimToken!, "twice@test.ca"), ctx()),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.response.codes).toEqual(b.response.codes);
    expect(await db.claims.find().toArray()).toHaveLength(2);
    expect(await db.codes.find({ status: "assigned" }).toArray()).toHaveLength(2);
    expect(await db.emailOutbox.find().toArray()).toHaveLength(1);
  });
});
