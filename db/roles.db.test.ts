import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@/db/client";
import { runMigrations } from "@/db/migrations";
import { createAppUser } from "@/db/roles";
import { newConsent, newPlayer } from "@/db/schema";
import { claimersCsv } from "@/lib/server/admin/export";
import { funnel, health } from "@/lib/server/admin/dashboard";
import {
  erasePlayer,
  exportPlayer,
  playerDetail,
  renamePlayer,
  searchPlayers,
  setHidden,
} from "@/lib/server/admin/players";
import { importCodes, markRedeemed, poolStats, recentBatches } from "@/lib/server/admin/pools";
import { runRetention } from "@/lib/server/admin/retention";
import { loadSettings, saveSettings, toForm, validateSettings } from "@/lib/server/admin/settings";
import { runStockAlerts } from "@/lib/server/admin/stock-alerts";
import { checkAlerts } from "@/lib/server/alerts";
import { montrealDay, recordServerEvent, rollupEvents } from "@/lib/server/analytics";
import { claimRewards } from "@/lib/server/claims";
import { setDbForTests } from "@/lib/server/db";
import { deliverEmail, queueResend } from "@/lib/server/email/deliver";
import { topEntries } from "@/lib/server/leaderboard";
import { signToken } from "@/lib/server/tokens";
import { unsubscribe } from "@/lib/server/unsubscribe";
import { BOTH, ctx, finish, seedCampaign } from "@/tests/db";

// The app's database user holds only db/roles.ts. These tests start their own server with
// authentication on, so they don't use the shared one from tests/db-setup.ts.
const ROOT_PASSWORD = "root-password-0123456789";
const APP_PASSWORD = "app-password-0123456789";

let rs: MongoMemoryReplSet;
let admin: ReturnType<typeof createDb>;
let app: ReturnType<typeof createDb>;

beforeAll(async () => {
  rs = await MongoMemoryReplSet.create({
    replSet: {
      count: 1,
      storageEngine: "wiredTiger",
      auth: { enable: true, customRootName: "root", customRootPwd: ROOT_PASSWORD },
    },
  });
  const uri = new URL(rs.getUri());
  const connect = (user: string, password: string, authSource: string) =>
    `mongodb://${user}:${password}@${uri.host}/boustan?replicaSet=${uri.searchParams.get("replicaSet")}&authSource=${authSource}`;
  admin = createDb(connect("root", ROOT_PASSWORD, "admin"));
  await runMigrations(admin.db);
  await createAppUser(admin.db.mongo, APP_PASSWORD);
  // The migration seeds the settings document; the test adds its own, open campaign.
  await admin.db.campaignSettings.deleteMany({});
  await seedCampaign(admin.db, { codesPerReward: 5 });
  app = createDb(connect("boustan_app", APP_PASSWORD, "boustan"));
  setDbForTests(app.db);
}, 180_000);

afterAll(async () => {
  setDbForTests(undefined);
  await app?.client.close();
  await admin?.client.close();
  await rs?.stop();
});

describe("the app's database user (NFR-06)", () => {
  it("can do everything the game and the admin do", async () => {
    const db = app.db;
    const sent: string[] = [];
    const send = async (e: { to: string }) => {
      sent.push(e.to);
      return { id: "r1" };
    };

    // A player's run, claim, email and unsubscribe.
    const run = await finish(db, BOTH());
    const claim = await claimRewards(
      db,
      {
        claimToken: run.claimToken!,
        email: "role@example.com",
        lang: "en",
        termsAge: true,
        marketingOptIn: true,
        src: "role-test",
        utm: {},
      },
      ctx(),
    );
    if (!claim.ok) throw new Error(claim.error);
    expect(claim.response.codes).toHaveLength(2);
    expect(await deliverEmail(db, claim.emailId!, send)).toBe("sent");
    expect(sent).toEqual(["role@example.com"]);
    await unsubscribe(db, signToken("unsubscribe", { v: 1, p: claim.playerId }), ctx());
    await recordServerEvent(db, "opt_in", {}, { src: "role-test" });
    expect(await topEntries(db, 10)).toHaveLength(1);

    // The admin pages and tools.
    expect(await searchPlayers(db, "role@")).toHaveLength(1);
    expect((await playerDetail(db, claim.playerId))?.consents).toHaveLength(3);
    expect(await exportPlayer(db, claim.playerId)).not.toBeNull();
    expect(await claimersCsv(db, false)).toContain("role@example.com");
    expect(await poolStats(db)).toHaveLength(2);
    expect((await importCodes(db, "free_coke", "ROLE-1\nROLE-2\n")).ok).toBe(true);
    expect(await recentBatches(db)).not.toHaveLength(0);
    const assigned = (await admin.db.codes.findOne({ status: "assigned" }))!;
    expect((await markRedeemed(db, `code\n${assigned.code}\n`)).ok).toBe(true);
    await rollupEvents(db, montrealDay());
    await funnel(db, montrealDay(), montrealDay(), "day");
    expect((await health(db)).players).toBe(1);
    await checkAlerts(db);
    await runStockAlerts(db, send);
    expect(await setHidden(db, claim.playerId, true)).toBe(true);
    expect(await renamePlayer(db, claim.playerId, "Role Tester")).toBe("Role Tester");
    const claimIds = (await admin.db.claims.find().toArray()).map((c) => c._id);
    expect(await queueResend(db, claim.playerId, claimIds, "en", null)).not.toBeNull();
    const form = toForm(await loadSettings(db));
    const next = validateSettings({ ...form, claimsEnabled: false });
    if (!next.ok) throw new Error(next.errors.join());
    expect(await saveSettings(db, "admin@example.com", next.value)).toEqual(["claimsEnabled"]);

    // The retention job and erasing a player, which delete what nothing else may.
    await admin.db.campaignSettings.updateOne(
      {},
      { $set: { endsAt: new Date(Date.now() - 200 * 86_400_000) } },
    );
    await admin.db.claims.updateMany(
      {},
      { $set: { expiresAt: new Date(Date.now() - 86_400_000) } },
    );
    expect((await runRetention(db)).anonymized).toBe(1);
    expect(await erasePlayer(db, claim.playerId)).toBeNull(); // already anonymized
    expect(await admin.db.consents.countDocuments()).toBe(0);
    expect(await admin.db.adminAudit.countDocuments()).toBeGreaterThan(1);
  });

  it("can't change the schema", async () => {
    const mongo = app.db.mongo;
    await expect(mongo.createCollection("other")).rejects.toThrow(/not authorized/i);
    await expect(mongo.collection("players").createIndex({ nickname: 1 })).rejects.toThrow(
      /not authorized/i,
    );
    await expect(mongo.collection("players").drop()).rejects.toThrow(/not authorized/i);
    await expect(
      mongo.command({ collMod: "consents", validator: {}, validationLevel: "off" }),
    ).rejects.toThrow(/not authorized/i);
  });

  it("can append to the consent and audit logs and read them, but never rewrite them", async () => {
    const db = app.db;
    const consent = newConsent({
      playerId: "p",
      kind: "marketing",
      granted: true,
      text: "…",
      textVersion: "v1",
      language: "fr",
      source: "claim_form",
    });
    await db.consents.insertOne(consent);
    expect(await db.consents.findOne({ _id: consent._id })).not.toBeNull();
    await expect(
      db.consents.updateOne({ _id: consent._id }, { $set: { granted: false } }),
    ).rejects.toThrow(/not authorized/i);
    await expect(
      db.consents.replaceOne({ _id: consent._id }, { ...consent, granted: false }),
    ).rejects.toThrow(/not authorized/i);
    // Upserts need `update` too, so a consent can't be rewritten that way either.
    await expect(
      db.consents.updateOne({ _id: consent._id }, { $set: { text: "x" } }, { upsert: true }),
    ).rejects.toThrow(/not authorized/i);

    const audit = (await db.adminAudit.findOne())!;
    await expect(
      db.adminAudit.updateOne({ _id: audit._id }, { $set: { action: "x" } }),
    ).rejects.toThrow(/not authorized/i);
    await expect(db.adminAudit.deleteMany({})).rejects.toThrow(/not authorized/i);
  });

  it("can't delete or edit what it only reads or adds to", async () => {
    const db = app.db;
    await expect(db.events.deleteMany({})).rejects.toThrow(/not authorized/i);
    await expect(db.events.updateMany({}, { $set: { name: "x" } })).rejects.toThrow(
      /not authorized/i,
    );
    await expect(db.players.deleteMany({})).rejects.toThrow(/not authorized/i);
    await expect(db.runs.deleteMany({})).rejects.toThrow(/not authorized/i);
    await expect(db.codes.deleteMany({})).rejects.toThrow(/not authorized/i);
    // Settings and rewards come from migrations and seeds: the app edits them, nothing more.
    await expect(db.rewards.deleteMany({})).rejects.toThrow(/not authorized/i);
    await expect(
      db.rewards.insertOne({ ...(await db.rewards.findOne())!, _id: "free_pizza" }),
    ).rejects.toThrow(/not authorized/i);
    await expect(db.campaignSettings.deleteMany({})).rejects.toThrow(/not authorized/i);
    // What it should be able to do is an ordinary write.
    await db.players.insertOne(
      newPlayer({ email: "a@b.ca", emailNormalized: "a@b.ca", language: "fr" }),
    );
  });
});
