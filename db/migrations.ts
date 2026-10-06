/**
 * Schema migrations, applied in order by `npm run db:migrate` and remembered in the
 * `schema_migrations` collection. Add a migration to the end of MIGRATIONS and never edit one
 * that has shipped. Each `up` must be safe to run twice: two deploys can race, and a failed run
 * is simply repeated.
 *
 * Migrations only add things (collections, indexes, fields with a default the code tolerates),
 * so the running version keeps working while a new one is rolled out.
 */
import type { Db as MongoDb, Document } from "mongodb";
import type { Db } from "./client";
import {
  COLLECTIONS,
  INDEXES,
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
 * Everything the first version of the app needs: the collections with their validators (the
 * old CHECK constraints), every index, and the single campaign settings document. Claims stay
 * off until someone sets dates and turns them on.
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

export const MIGRATIONS: Migration[] = [{ id: "0000_init", up: init }];

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
