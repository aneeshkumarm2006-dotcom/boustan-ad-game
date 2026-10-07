import { ObjectId, type Db as MongoDb, type Document } from "mongodb";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type Db } from "@/db/client";
import { MIGRATIONS, runMigrations } from "@/db/migrations";
import {
  COLLECTIONS,
  INDEXES,
  LEGACY_COLLECTIONS,
  VALIDATORS,
  type CollectionKey,
} from "@/db/schema";

// Each scenario gets its own database on the shared test server, so none of them can disturb
// the database the other suites use. The databases are dropped afterwards.
const scratch: { db: Db; close: () => Promise<void> }[] = [];

async function freshDatabase(name: string): Promise<Db> {
  const url = new URL(inject("databaseUrl"));
  url.pathname = `/${name}`;
  const { db, client } = createDb(url.toString(), { max: 2 });
  await db.mongo.dropDatabase();
  scratch.push({ db, close: () => client.close() });
  return db;
}

afterAll(async () => {
  for (const { db, close } of scratch) {
    await db.mongo.dropDatabase();
    await close();
  }
});

const collectionNames = async (mongo: MongoDb) =>
  (await mongo.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort();
const indexNames = async (mongo: MongoDb, collection: string) =>
  (await mongo.collection(collection).indexes()).map((i) => i.name).sort();
const NEW_COLLECTIONS = [...Object.values(COLLECTIONS), "schema_migrations"].sort();

/** A collection read and written as plain documents, with any kind of `_id`. */
type RawDoc = Document & { _id: string | number | ObjectId };
const raw = (mongo: MongoDb, name: string) => mongo.collection<RawDoc>(name);

describe("a new database", () => {
  let db: Db;
  let first: string[];
  let second: string[];

  beforeAll(async () => {
    db = await freshDatabase("migrations_fresh");
    first = await runMigrations(db);
    second = await runMigrations(db);
  });

  it("gets every migration once, and nothing the second time", async () => {
    expect(first).toEqual(["0000_init", "0001_points_leaderboard"]);
    expect(second).toEqual([]);
    const ledger = await db.mongo.collection("schema_migrations").find().sort({ _id: 1 }).toArray();
    expect(ledger.map((m) => m._id)).toEqual(["0000_init", "0001_points_leaderboard"]);
  });

  it("has exactly the collections of the schema, and none of the old design's", async () => {
    const names = await collectionNames(db.mongo);
    expect(names).toEqual(NEW_COLLECTIONS);
    for (const legacy of LEGACY_COLLECTIONS) expect(names).not.toContain(legacy);
  });

  it("has every index of the schema and no others", async () => {
    for (const key of Object.keys(COLLECTIONS) as CollectionKey[]) {
      const expected = ["_id_", ...INDEXES[key].map((spec) => spec.options.name)].sort();
      expect(await indexNames(db.mongo, COLLECTIONS[key]), key).toEqual(expected);
    }
  });

  it("orders the leaderboard by points, not by garlic and hits", async () => {
    const indexes = await db.mongo.collection("best_runs").indexes();
    expect(indexes.map((i) => i.name)).toContain("best_runs_points_idx");
    expect(indexes.map((i) => i.name)).not.toContain("best_runs_rank_idx");
    expect(indexes.find((i) => i.name === "best_runs_points_idx")!.key).toEqual({
      points: -1,
      achievedAt: 1,
      _id: 1,
    });
  });

  it("installs the validators", async () => {
    for (const key of Object.keys(VALIDATORS) as CollectionKey[]) {
      const [info] = await db.mongo
        .listCollections({ name: COLLECTIONS[key] }, { nameOnly: false })
        .toArray();
      expect(info.options?.validator, key).toEqual(VALIDATORS[key]);
    }
  });

  it("seeds the one settings document with the leaderboard off", async () => {
    const rows = await db.campaignSettings.find().toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      _id: 1,
      startsAt: null,
      endsAt: null,
      leaderboardOpen: false,
      retentionDays: 90,
    });
    expect(rows[0]).not.toHaveProperty("claimsEnabled");
    expect(rows[0]).not.toHaveProperty("alertEmails");
  });

  it("lists its migrations in order, each once", () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(ids).toEqual(["0000_init", "0001_points_leaderboard"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });
});

// ---------------------------------------------------------------------------------------------
// A database from the rewards-and-coupons design, as `npm run db:migrate` of that version left it
// ---------------------------------------------------------------------------------------------

const D = (iso: string) => new Date(iso);
const T0 = D("2026-10-10T12:00:00Z");

/** The validators of the old design, frozen here so a later change to the schema can't alter them. */
const LEGACY_VALIDATORS: Record<string, Document> = {
  consents: {
    $jsonSchema: {
      bsonType: "object",
      required: ["kind"],
      properties: { kind: { enum: ["terms_age", "marketing"] } },
    },
  },
  runs: {
    $jsonSchema: {
      bsonType: "object",
      required: ["status"],
      properties: { status: { enum: ["valid", "flagged"] } },
    },
  },
  campaign_settings: {
    $jsonSchema: {
      bsonType: "object",
      required: ["_id", "retentionDays"],
      properties: { _id: { enum: [1] }, retentionDays: { bsonType: "number", minimum: 0 } },
    },
  },
  rewards: {
    $jsonSchema: {
      bsonType: "object",
      required: ["maxPerPlayer"],
      properties: { maxPerPlayer: { enum: [1] } },
    },
  },
  codes: {
    $jsonSchema: {
      bsonType: "object",
      required: ["status"],
      properties: { status: { enum: ["available", "assigned", "redeemed", "void"] } },
    },
  },
};

const RUNS = {
  coke: "11111111-1111-4111-8111-111111111111",
  short: "22222222-2222-4222-8222-222222222222",
  unsaved: "33333333-3333-4333-8333-333333333333",
  flagged: "44444444-4444-4444-8444-444444444444",
};

const legacyRun = (over: Document & { _id: string }) => ({
  seed: 1,
  playerId: "p1",
  src: "lapresse",
  hostOrigin: "https://news.example",
  utm: {},
  language: "fr",
  rules: { distanceM: 100, garlic: 10 },
  tuningVersion: 1,
  issuedAt: T0,
  finishedAt: T0,
  activeMs: 30_000,
  hits: 1,
  flagReason: null,
  clientVersion: "abc",
  claimedAt: T0,
  ...over,
});

const legacyPlayer = (over: Document & { _id: string }) => ({
  nickname: "Nick",
  hidden: false,
  language: "fr",
  ageConfirmedAt: T0,
  marketingOptIn: false,
  firstSrc: null,
  firstHost: null,
  utm: {},
  crmStatus: "pending",
  crmSyncedAt: null,
  createdAt: T0,
  lastSeenAt: T0,
  deletedAt: null,
  ...over,
});

const legacyCrm = (over: Document) => ({
  _id: new ObjectId(),
  playerId: "p1",
  payload: {},
  status: "pending",
  attempts: 0,
  nextAttemptAt: T0,
  lastError: null,
  createdAt: T0,
  sentAt: null,
  ...over,
});

const legacyConsent = (over: Document) => ({
  _id: new ObjectId(),
  playerId: "p1",
  kind: "marketing",
  language: "fr",
  textVersion: "fr-2026-10-06-draft",
  hostOrigin: null,
  createdAt: T0,
  ...over,
});

/** Builds the old shape by hand: every collection, the old leaderboard index, and some data. */
async function buildLegacy(db: Db, { claimsEnabled = true }: { claimsEnabled?: boolean } = {}) {
  const { mongo } = db;
  for (const name of [...Object.values(COLLECTIONS), ...LEGACY_COLLECTIONS]) {
    const validator = LEGACY_VALIDATORS[name];
    await mongo.createCollection(
      name,
      validator ? { validator, validationLevel: "strict", validationAction: "error" } : undefined,
    );
  }
  await mongo
    .collection("best_runs")
    .createIndex(
      { garlic: -1, hits: 1, distanceM: -1, achievedAt: 1, _id: 1 },
      { name: "best_runs_rank_idx" },
    );

  await raw(mongo, "players").insertMany([
    legacyPlayer({
      _id: "p1",
      email: "p1@x.ca",
      emailNormalized: "p1@x.ca",
      marketingOptIn: true,
      emailBlockedAt: T0,
      emailBlockReason: "bounced",
    }),
    legacyPlayer({ _id: "p2", email: "p2@x.ca", emailNormalized: "p2@x.ca" }),
  ]);
  await raw(mongo, "runs").insertMany([
    // 163.5 m and 12 garlic is 163 + 120.
    legacyRun({ _id: RUNS.coke, distanceM: 163.5, garlic: 12, status: "valid" }),
    // Under a metre, no garlic: nothing.
    legacyRun({ _id: RUNS.short, playerId: "p2", distanceM: 0.9, garlic: 0, status: "valid" }),
    // Never claimed: claimedAt is null, and stays null as savedAt.
    legacyRun({
      _id: RUNS.unsaved,
      playerId: null,
      distanceM: 41.5,
      garlic: 0,
      status: "valid",
      claimedAt: null,
    }),
    // A flagged run claims what it likes and earns nothing.
    legacyRun({
      _id: RUNS.flagged,
      distanceM: 900,
      garlic: 60,
      status: "flagged",
      flagReason: "distance",
      claimedAt: null,
    }),
  ]);
  await raw(mongo, "best_runs").insertMany([
    { _id: "p1", runId: RUNS.coke, garlic: 12, hits: 1, distanceM: 163.5, achievedAt: T0 },
    { _id: "p2", runId: RUNS.unsaved, garlic: 0, hits: 0, distanceM: 41.5, achievedAt: T0 },
  ]);
  await raw(mongo, "campaign_settings").insertOne({
    _id: 1,
    startsAt: D("2026-10-15T04:00:00Z"),
    endsAt: D("2026-11-15T05:00:00Z"),
    claimsEnabled,
    alertEmails: ["stock@boustan.test"],
    retentionDays: 45,
    updatedAt: T0,
    updatedBy: "cli:someone",
  });
  await mongo.collection("consents").insertMany([
    legacyConsent({
      granted: true,
      text: "Envoyez-moi les offres et nouvelles de Boustan par courriel.",
      source: "claim_form",
      ip: "203.0.113.5",
      userAgent: "legacy",
    }),
    legacyConsent({
      granted: false,
      text: "Désabonnement des offres et nouvelles de Boustan par courriel.",
      source: "unsubscribe",
      ip: null,
      userAgent: null,
    }),
  ]);
  await mongo.collection("crm_outbox").insertMany([
    legacyCrm({ type: "reward_claimed", idempotencyKey: "claim:pending", status: "pending" }),
    legacyCrm({
      type: "reward_claimed",
      idempotencyKey: "claim:sent",
      status: "sent",
      sentAt: T0,
    }),
    legacyCrm({ type: "contact_upsert", idempotencyKey: "contact:p1", status: "pending" }),
    legacyCrm({ type: "consent_changed", idempotencyKey: "consent:p1", status: "pending" }),
  ]);
  await raw(mongo, "rewards").insertOne({
    _id: "free_coke",
    maxPerPlayer: 1,
    rule: { distanceM: 100 },
  });
  await mongo
    .collection("codes")
    .insertOne({ rewardId: "free_coke", code: "A-1", status: "available" });
  await mongo.collection("claims").insertOne({ playerId: "p1", rewardId: "free_coke" });
  await mongo.collection("email_outbox").insertOne({ playerId: "p1", kind: "coupon" });
  // The old version had run 0000, and only that.
  await raw(mongo, "schema_migrations").insertOne({ _id: "0000_init", appliedAt: T0 });
}

/** Every document of every collection, and the index names, as plain JSON: for before and after. */
async function snapshot(mongo: MongoDb) {
  const out: Record<string, unknown> = {};
  for (const name of await collectionNames(mongo)) {
    const docs = await mongo.collection(name).find().sort({ _id: 1 }).toArray();
    out[name] = { docs: JSON.parse(JSON.stringify(docs)), indexes: await indexNames(mongo, name) };
  }
  return out;
}

const migration = MIGRATIONS.find((m) => m.id === "0001_points_leaderboard")!;
const rows = (db: Db, name: string) => db.mongo.collection(name).find().sort({ _id: 1 }).toArray();
const one = (db: Db, name: string, _id: string | number) => raw(db.mongo, name).findOne({ _id });

describe("a database from the rewards-and-coupons design (migration 0001)", () => {
  let db: Db;
  let consentsBefore: unknown;

  beforeAll(async () => {
    db = await freshDatabase("migrations_legacy");
    await buildLegacy(db);
    consentsBefore = JSON.parse(JSON.stringify(await rows(db, "consents")));
    await migration.up(db);
  });

  it("gives every run its points: whole metres plus 10 per garlic, and 0 for a flagged run", async () => {
    expect((await one(db, "runs", RUNS.coke))!.points).toBe(163 + 12 * 10);
    expect((await one(db, "runs", RUNS.short))!.points).toBe(0);
    expect((await one(db, "runs", RUNS.unsaved))!.points).toBe(41);
    expect((await one(db, "runs", RUNS.flagged))!.points).toBe(0);
    // The rest of a run is left as it was.
    expect(await one(db, "runs", RUNS.flagged)).toMatchObject({
      distanceM: 900,
      garlic: 60,
      status: "flagged",
      flagReason: "distance",
    });
  });

  it("renames claimedAt to savedAt and drops the rules a run carried", async () => {
    for (const run of await rows(db, "runs")) {
      expect(run).not.toHaveProperty("claimedAt");
      expect(run).not.toHaveProperty("rules");
      expect(run).toHaveProperty("savedAt");
    }
    expect((await one(db, "runs", RUNS.coke))!.savedAt).toEqual(T0);
    expect((await one(db, "runs", RUNS.unsaved))!.savedAt).toBeNull();
  });

  it("gives best runs their points and drops the hits", async () => {
    expect(await one(db, "best_runs", "p1")).toEqual({
      _id: "p1",
      runId: RUNS.coke,
      points: 283,
      garlic: 12,
      distanceM: 163.5,
      achievedAt: T0,
    });
    expect(await one(db, "best_runs", "p2")).toMatchObject({ points: 41, garlic: 0 });
    for (const best of await rows(db, "best_runs")) expect(best).not.toHaveProperty("hits");
  });

  it("orders the leaderboard by points: the new index exists and the old one is gone", async () => {
    const indexes = await db.mongo.collection("best_runs").indexes();
    expect(indexes.map((i) => i.name).sort()).toEqual(["_id_", "best_runs_points_idx"]);
    expect(indexes.find((i) => i.name === "best_runs_points_idx")!.key).toEqual({
      points: -1,
      achievedAt: 1,
      _id: 1,
    });
  });

  it("turns the claims switch into the leaderboard switch, and drops the old settings", async () => {
    expect(await one(db, "campaign_settings", 1)).toEqual({
      _id: 1,
      startsAt: D("2026-10-15T04:00:00Z"),
      endsAt: D("2026-11-15T05:00:00Z"),
      leaderboardOpen: true,
      retentionDays: 45,
      updatedAt: T0,
      updatedBy: "cli:someone",
    });
  });

  it("removes the block fields from players and leaves the rest of them alone", async () => {
    for (const player of await rows(db, "players")) {
      expect(player).not.toHaveProperty("emailBlockedAt");
      expect(player).not.toHaveProperty("emailBlockReason");
    }
    expect(await one(db, "players", "p1")).toMatchObject({
      email: "p1@x.ca",
      marketingOptIn: true,
      nickname: "Nick",
    });
  });

  it("skips the coupon events still waiting for the CRM, and touches no other row", async () => {
    const byKey = Object.fromEntries(
      (await rows(db, "crm_outbox")).map((r) => [r.idempotencyKey, r]),
    );
    expect(byKey["claim:pending"]).toMatchObject({
      status: "skipped",
      lastError: "rewards were removed",
    });
    expect(byKey["claim:sent"]).toMatchObject({ status: "sent", lastError: null });
    expect(byKey["contact:p1"]).toMatchObject({ status: "pending", lastError: null });
    expect(byKey["consent:p1"]).toMatchObject({ status: "pending", lastError: null });
  });

  it("drops the collections of the old design and keeps every other", async () => {
    expect(await collectionNames(db.mongo)).toEqual(NEW_COLLECTIONS);
  });

  it("leaves the consent log exactly as it was: it is the record of what each player saw", async () => {
    expect(JSON.parse(JSON.stringify(await rows(db, "consents")))).toEqual(consentsBefore);
    expect((consentsBefore as { source: string }[]).map((c) => c.source).sort()).toEqual([
      "claim_form",
      "unsubscribe",
    ]);
  });

  it("can run twice: the second run fails on nothing and changes nothing", async () => {
    const once = await snapshot(db.mongo);
    await migration.up(db);
    expect(await snapshot(db.mongo)).toEqual(once);
  });
});

describe("other databases the migration meets", () => {
  it("keeps the leaderboard off where claims were off", async () => {
    const db = await freshDatabase("migrations_legacy_off");
    await buildLegacy(db, { claimsEnabled: false });
    await migration.up(db);
    expect(await one(db, "campaign_settings", 1)).toMatchObject({ leaderboardOpen: false });
    expect(await one(db, "campaign_settings", 1)).not.toHaveProperty("claimsEnabled");
  });

  it("opens nothing where the settings knew neither switch", async () => {
    const db = await freshDatabase("migrations_legacy_bare");
    await raw(db.mongo, "campaign_settings").insertOne({ _id: 1, retentionDays: 90 });
    await migration.up(db);
    expect(await one(db, "campaign_settings", 1)).toEqual({
      _id: 1,
      retentionDays: 90,
      leaderboardOpen: false,
    });
  });

  it("copes with a database that has none of the old collections", async () => {
    const db = await freshDatabase("migrations_legacy_empty");
    await migration.up(db);
    expect(await collectionNames(db.mongo)).toEqual(["best_runs"]);
    expect(await indexNames(db.mongo, "best_runs")).toEqual(["_id_", "best_runs_points_idx"]);
  });

  it("is the only migration `npm run db:migrate` applies to a database that already ran 0000", async () => {
    const db = await freshDatabase("migrations_legacy_ledger");
    await buildLegacy(db);
    expect(await runMigrations(db)).toEqual(["0001_points_leaderboard"]);
    expect(await runMigrations(db)).toEqual([]);
    expect(await collectionNames(db.mongo)).toEqual(NEW_COLLECTIONS);
    expect((await one(db, "runs", RUNS.coke))!.points).toBe(283);
  });
});
