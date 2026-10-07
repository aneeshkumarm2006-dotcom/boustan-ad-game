/**
 * Schema migrations, applied in order by `npm run db:migrate` and remembered in the
 * `schema_migrations` collection. Add a migration to the end of MIGRATIONS and never edit one
 * that has shipped. Each `up` must be safe to run twice: two deploys can race, and a failed run
 * is simply repeated.
 *
 * Migrations normally only add things (collections, indexes, fields with a default the code
 * tolerates), so the running version keeps working while a new one is rolled out. 0001 is the
 * exception: it moves a database from the rewards-and-coupons design to the points contest, which
 * removes collections the new code no longer knows. That happened before launch, so no deploy
 * ever ran the two versions side by side.
 */
import type { Db as MongoDb, Document } from "mongodb";
import type { Db } from "./client";
import {
  BEST_RUNS_RANK_INDEX,
  COLLECTIONS,
  INDEXES,
  LEGACY_COLLECTIONS,
  VALIDATORS,
  newCampaignSettings,
  type CampaignSettingsDoc,
  type CollectionKey,
} from "./schema";

export interface Migration {
  id: string;
  up(db: Db): Promise<void>;
}

const NAMESPACE_EXISTS = 48;

/** Creates the collection with its validator, or brings an existing one's validator up to date. */
async function ensureCollection(mongo: MongoDb, name: string, validator?: Document) {
  const options = validator
    ? { validator, validationLevel: "strict", validationAction: "error" }
    : undefined;
  const exists = (await mongo.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
  if (!exists) {
    try {
      await mongo.createCollection(name, options);
      return;
    } catch (error) {
      // Another process created it between the check and now.
      if ((error as { code?: number }).code !== NAMESPACE_EXISTS) throw error;
    }
  }
  if (options) await mongo.command({ collMod: name, ...options });
}

/**
 * Everything the app needs: the collections with their validators (the old CHECK constraints),
 * every index, and the single campaign settings document. The leaderboard stays closed until
 * someone sets dates and opens it.
 */
async function init({ mongo }: Db) {
  for (const key of Object.keys(COLLECTIONS) as CollectionKey[]) {
    const name = COLLECTIONS[key];
    await ensureCollection(mongo, name, VALIDATORS[key]);
    for (const spec of INDEXES[key]) {
      await mongo.collection(name).createIndex(spec.key, spec.options);
    }
  }
  await mongo
    .collection<CampaignSettingsDoc>(COLLECTIONS.campaignSettings)
    .updateOne({ _id: 1 }, { $setOnInsert: newCampaignSettings() }, { upsert: true });
}

const INDEX_NOT_FOUND = 27;
const NAMESPACE_NOT_FOUND = 26;

/** Whole metres plus 10 per garlic: the scoring rule as it was when this migration was written. */
const POINTS_EXPRESSION = { $add: [{ $floor: "$distanceM" }, { $multiply: ["$garlic", 10] }] };

/**
 * Moves a database from rewards and coupons to the points contest. A database that 0000 just
 * created already has the new shape, so each step finds nothing to do there. Every step can run
 * twice.
 *
 * - runs and best_runs get `points` (1 per whole metre plus 10 per garlic; flagged runs earn 0),
 *   and the leaderboard index becomes points, then who got there first.
 * - the campaign's claims switch becomes the leaderboard switch.
 * - the rewards, codes, claims and coupon-email collections are dropped, with the fields that
 *   only they used.
 *
 * Consent rows are left as they are: they are the legal record of what each player saw.
 */
async function pointsLeaderboard({ mongo }: Db) {
  const runs = mongo.collection(COLLECTIONS.runs);
  await runs.updateMany({ points: { $exists: false } }, [
    {
      $set: {
        points: { $cond: [{ $eq: ["$status", "valid"] }, POINTS_EXPRESSION, 0] },
      },
    },
  ]);
  await runs.updateMany({ claimedAt: { $exists: true } }, { $rename: { claimedAt: "savedAt" } });
  await runs.updateMany({ rules: { $exists: true } }, { $unset: { rules: "" } });

  const best = mongo.collection(COLLECTIONS.bestRuns);
  await best.updateMany({ points: { $exists: false } }, [{ $set: { points: POINTS_EXPRESSION } }]);
  await best.updateMany({ hits: { $exists: true } }, { $unset: { hits: "" } });
  try {
    await best.dropIndex("best_runs_rank_idx");
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code !== INDEX_NOT_FOUND && code !== NAMESPACE_NOT_FOUND) throw error;
  }
  await best.createIndex(BEST_RUNS_RANK_INDEX.key, BEST_RUNS_RANK_INDEX.options);

  const settings = mongo.collection(COLLECTIONS.campaignSettings);
  await settings.updateMany(
    { leaderboardOpen: { $exists: false }, claimsEnabled: { $exists: true } },
    [{ $set: { leaderboardOpen: "$claimsEnabled" } }],
  );
  await settings.updateMany(
    { leaderboardOpen: { $exists: false } },
    { $set: { leaderboardOpen: false } },
  );
  await settings.updateMany(
    { $or: [{ claimsEnabled: { $exists: true } }, { alertEmails: { $exists: true } }] },
    { $unset: { claimsEnabled: "", alertEmails: "" } },
  );

  await mongo
    .collection(COLLECTIONS.players)
    .updateMany(
      { $or: [{ emailBlockedAt: { $exists: true } }, { emailBlockReason: { $exists: true } }] },
      { $unset: { emailBlockedAt: "", emailBlockReason: "" } },
    );
  await mongo
    .collection(COLLECTIONS.crmOutbox)
    .updateMany(
      { type: "reward_claimed", status: "pending" },
      { $set: { status: "skipped", lastError: "rewards were removed" } },
    );

  for (const name of LEGACY_COLLECTIONS) {
    const exists = (await mongo.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
    if (exists) await mongo.dropCollection(name);
  }
}

export const MIGRATIONS: Migration[] = [
  { id: "0000_init", up: init },
  { id: "0001_points_leaderboard", up: pointsLeaderboard },
];

const LEDGER = "schema_migrations";

/** Applies every migration not yet recorded. Returns the ids it applied. */
export async function runMigrations(db: Db): Promise<string[]> {
  const ledger = db.mongo.collection<{ _id: string; appliedAt: Date }>(LEDGER);
  const done = new Set((await ledger.find().toArray()).map((m) => m._id));
  const applied: string[] = [];
  for (const migration of MIGRATIONS) {
    if (done.has(migration.id)) continue;
    await migration.up(db);
    await ledger.updateOne(
      { _id: migration.id },
      { $setOnInsert: { appliedAt: new Date() } },
      { upsert: true },
    );
    applied.push(migration.id);
  }
  return applied;
}
