import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@/db/client";
import { runMigrations } from "@/db/migrations";
import { createAppUser } from "@/db/roles";
import { newConsent, newPlayer } from "@/db/schema";
import { funnel, health } from "@/lib/server/admin/dashboard";
import { playersCsv } from "@/lib/server/admin/export";
import { winners } from "@/lib/server/admin/moderation";
import {
  erasePlayer,
  exportPlayer,
  playerDetail,
  renamePlayer,
  searchPlayers,
  setHidden,
} from "@/lib/server/admin/players";
import { runRetention } from "@/lib/server/admin/retention";
import { loadSettings, saveSettings, toForm, validateSettings } from "@/lib/server/admin/settings";
import { checkAlerts } from "@/lib/server/alerts";
import { montrealDay, recordServerEvent, rollupEvents } from "@/lib/server/analytics";
import { setDbForTests } from "@/lib/server/db";
import { topEntries } from "@/lib/server/leaderboard";
import { GOOD, SHORT, finish, honestRun, save, seedCampaign } from "@/tests/db";

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
  // The migration seeds the settings document; the test adds its own, open contest.
  await admin.db.campaignSettings.deleteMany({});
  await seedCampaign(admin.db);
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

    // Four players, best first: a new player saves with an email, a known device is saved as it
    // finishes, and the opted-in one gives a consent row more.
    const first = await save(db, await finish(db, GOOD()), "role@example.com", {
      marketingOptIn: true,
      src: "role-test",
    });
    expect(first.response.rank).toBe(1);
    const device = first.response.playerToken;
    const again = await finish(db, honestRun(21, 20, 4, 1), device);
    expect(again).toMatchObject({ valid: true, saveToken: null });
    const second = await save(db, await finish(db, honestRun(22, 18, 2, 0)), "two@example.com");
    const third = await save(db, await finish(db, honestRun(23, 12, 1, 0)), "three@example.com");
    const fourth = await save(db, await finish(db, SHORT()), "four@example.com");
    expect(fourth.response.rank).toBe(4);
    await recordServerEvent(db, "opt_in", {}, { src: "role-test" });
    expect(await topEntries(db, 10)).toHaveLength(4);

    // The admin pages and tools.
    expect(await searchPlayers(db, "role@")).toHaveLength(1);
    expect((await playerDetail(db, first.playerId))?.consents).toHaveLength(2);
    expect(await exportPlayer(db, first.playerId)).not.toBeNull();
    expect(await playersCsv(db, { winnersOnly: false, optedInOnly: false })).toContain(
      "role@example.com",
    );
    expect((await winners(db)).map((w) => w.email)).toEqual([
      "role@example.com",
      "two@example.com",
      "three@example.com",
    ]);
    await rollupEvents(db, montrealDay());
    await funnel(db, montrealDay(), montrealDay(), "day");
    expect((await health(db)).players).toBe(4);
    await checkAlerts(db);
    expect(await setHidden(db, third.playerId, true)).toBe(true);
    expect(await renamePlayer(db, third.playerId, "Role Tester")).toBe("Role Tester");
    expect(await setHidden(db, third.playerId, false)).toBe(true);
    const form = toForm(await loadSettings(db));
    const next = validateSettings({ ...form, leaderboardOpen: false });
    if (!next.ok) throw new Error(next.errors.join());
    expect(await saveSettings(db, "admin@example.com", next.value)).toEqual(["leaderboardOpen"]);

    // The retention job and erasing a player, which delete what nothing else may. The contest
    // ended long ago: the two non-winners who didn't opt in are anonymized, the winners kept.
    await admin.db.campaignSettings.updateOne(
      {},
      { $set: { endsAt: new Date(Date.now() - 200 * 86_400_000) } },
    );
    expect((await runRetention(db)).anonymized).toBe(1);
    expect(await erasePlayer(db, fourth.playerId)).toBeNull(); // already anonymized
    expect(await admin.db.consents.countDocuments({ playerId: fourth.playerId })).toBe(0);
    expect(await admin.db.consents.countDocuments({ playerId: second.playerId })).toBe(1);
    expect(await admin.db.bestRuns.countDocuments()).toBe(3);
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
      source: "save_form",
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
    // The settings row comes from migrations and seeds: the app edits it, nothing more.
    await expect(db.campaignSettings.deleteMany({})).rejects.toThrow(/not authorized/i);
    await expect(
      db.campaignSettings.insertOne({ ...(await db.campaignSettings.findOne())!, _id: 2 }),
    ).rejects.toThrow(/not authorized/i);
    // What it should be able to do is an ordinary write.
    await db.players.insertOne(
      newPlayer({ email: "a@b.ca", emailNormalized: "a@b.ca", language: "fr" }),
    );
  });
});
