/**
 * MongoDB connections through the official driver (NFR-04). Transactions need a replica set:
 * Atlas clusters always are one, and `npm run db:local` starts one for development.
 *
 * `Db` and `Tx` expose the same typed collections, so a function that takes a `Queryable` runs
 * the same code on the pool or inside a transaction. Collections taken from a `Tx` carry the
 * session in every call (see `bind`), so a forgotten option can't leave a write outside the
 * transaction. Inside `transaction()`:
 *
 * - run operations one after another, never with Promise.all (the driver forbids parallel
 *   operations on a session);
 * - the callback can run more than once, when the server asks for a retry after a write
 *   conflict, so it must not have effects outside the database;
 * - don't catch a failed write and carry on: the server has already aborted the transaction.
 *   Where the old code relied on "on conflict do nothing", use `insertOnce`.
 */
import {
  MongoClient,
  MongoServerError,
  type ClientSession,
  type Collection,
  type Db as MongoDb,
  type Document,
  type Filter,
  type OptionalUnlessRequiredId,
  type TransactionOptions,
  type UpdateFilter,
} from "mongodb";
import {
  COLLECTIONS,
  type AdminAuditDoc,
  type BestRunDoc,
  type CampaignSettingsDoc,
  type ClaimDoc,
  type CodeDoc,
  type ConsentDoc,
  type CrmOutboxDoc,
  type EmailOutboxDoc,
  type EventDoc,
  type EventsDailyDoc,
  type PlayerDoc,
  type PlayerTokenDoc,
  type RewardDoc,
  type RunDoc,
} from "./schema";

export interface Collections {
  players: Collection<PlayerDoc>;
  playerTokens: Collection<PlayerTokenDoc>;
  consents: Collection<ConsentDoc>;
  runs: Collection<RunDoc>;
  bestRuns: Collection<BestRunDoc>;
  campaignSettings: Collection<CampaignSettingsDoc>;
  rewards: Collection<RewardDoc>;
  codes: Collection<CodeDoc>;
  claims: Collection<ClaimDoc>;
  emailOutbox: Collection<EmailOutboxDoc>;
  crmOutbox: Collection<CrmOutboxDoc>;
  events: Collection<EventDoc>;
  eventsDaily: Collection<EventsDailyDoc>;
  adminAudit: Collection<AdminAuditDoc>;
}

/** A transaction handle, as passed to db.transaction callbacks. */
export type Tx = Collections & { readonly session: ClientSession };

export type Db = Collections & {
  /** The raw database, for migrations and scripts. Not part of any transaction. */
  readonly mongo: MongoDb;
  /**
   * Runs `fn` in a transaction and returns its result. All of it is committed, or none of it is.
   * `fn` may be called again if the server reports a transient conflict; see the file comment.
   */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
};

/** Anything that can run queries: the pool or an open transaction. */
export type Queryable = Db | Tx;

export interface DbOptions {
  /** Connections per server instance. */
  max?: number;
}

const DEFAULT_DATABASE = "boustan";

/** The database named in the connection string (`mongodb://host/<name>?...`). */
function databaseName(url: string): string {
  const name = /^mongodb(?:\+srv)?:\/\/[^/?]+\/([^?]*)/.exec(url)?.[1];
  return name ? decodeURIComponent(name) : DEFAULT_DATABASE;
}

const TRANSACTION_OPTIONS: TransactionOptions = {
  readConcern: { level: "snapshot" },
  writeConcern: { w: "majority" },
  readPreference: "primary",
};

/**
 * The operations a transaction-bound collection allows, and where each takes its options
 * argument. Anything else throws, so a new kind of call is added here on purpose rather than
 * running outside the transaction by accident.
 */
const OPTIONS_ARG: Record<string, number> = {
  find: 1,
  findOne: 1,
  countDocuments: 1,
  aggregate: 1,
  distinct: 2,
  insertOne: 1,
  insertMany: 1,
  updateOne: 2,
  updateMany: 2,
  replaceOne: 2,
  deleteOne: 1,
  deleteMany: 1,
  findOneAndUpdate: 2,
  findOneAndDelete: 1,
  findOneAndReplace: 2,
  bulkWrite: 1,
};

/** The same collection, with `session` added to the options of every operation. */
function bind<T extends Document>(
  collection: Collection<T>,
  session: ClientSession,
): Collection<T> {
  return new Proxy(collection, {
    get(target, prop) {
      const member: unknown = Reflect.get(target, prop, target);
      if (typeof member !== "function" || typeof prop === "symbol" || prop === "constructor") {
        return member;
      }
      const at = OPTIONS_ARG[prop];
      if (at === undefined) {
        return () => {
          throw new Error(
            `collection.${prop}() isn't supported inside a transaction (db/client.ts)`,
          );
        };
      }
      return (...args: unknown[]) => {
        while (args.length <= at) args.push(undefined);
        args[at] = { ...(args[at] as object | undefined), session };
        return (member as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

function collectionsOf(mongo: MongoDb, session?: ClientSession): Collections {
  const get = <T extends Document>(name: string): Collection<T> => {
    const collection = mongo.collection<T>(name);
    return session ? bind(collection, session) : collection;
  };
  return {
    players: get<PlayerDoc>(COLLECTIONS.players),
    playerTokens: get<PlayerTokenDoc>(COLLECTIONS.playerTokens),
    consents: get<ConsentDoc>(COLLECTIONS.consents),
    runs: get<RunDoc>(COLLECTIONS.runs),
    bestRuns: get<BestRunDoc>(COLLECTIONS.bestRuns),
    campaignSettings: get<CampaignSettingsDoc>(COLLECTIONS.campaignSettings),
    rewards: get<RewardDoc>(COLLECTIONS.rewards),
    codes: get<CodeDoc>(COLLECTIONS.codes),
    claims: get<ClaimDoc>(COLLECTIONS.claims),
    emailOutbox: get<EmailOutboxDoc>(COLLECTIONS.emailOutbox),
    crmOutbox: get<CrmOutboxDoc>(COLLECTIONS.crmOutbox),
    events: get<EventDoc>(COLLECTIONS.events),
    eventsDaily: get<EventsDailyDoc>(COLLECTIONS.eventsDaily),
    adminAudit: get<AdminAuditDoc>(COLLECTIONS.adminAudit),
  };
}

/** The driver connects on first use, so this doesn't touch the network. */
export function createDb(url: string, { max = 5 }: DbOptions = {}) {
  const client = new MongoClient(url, {
    maxPoolSize: max,
    maxIdleTimeMS: 20_000,
    connectTimeoutMS: 10_000,
    serverSelectionTimeoutMS: 10_000,
    // A field set to undefined is left out instead of stored as null.
    ignoreUndefined: true,
    appName: "boustan-game",
  });
  const mongo = client.db(databaseName(url));

  const db: Db = {
    ...collectionsOf(mongo),
    mongo,
    async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      const session = client.startSession();
      try {
        return await session.withTransaction(
          () => fn({ ...collectionsOf(mongo, session), session }),
          TRANSACTION_OPTIONS,
        );
      } catch (error) {
        throw explain(error);
      } finally {
        await session.endSession();
      }
    },
  };
  return { db, client };
}

/** A standalone server can't run transactions; say so instead of the driver's wording. */
function explain(error: unknown): unknown {
  if (
    error instanceof MongoServerError &&
    error.code === 20 &&
    /replica set/i.test(error.message)
  ) {
    return new Error(
      "MongoDB transactions need a replica set. Atlas clusters are one; locally, run `npm run db:local`.",
      { cause: error },
    );
  }
  return error;
}

/** E11000: a unique index refused the write. */
export function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000;
}

/**
 * Inserts `doc` unless a document matching `filter` exists, and says whether it did: the
 * counterpart of "insert ... on conflict do nothing". `filter` must be an equality match on a
 * unique key. Unlike a plain insert it is safe inside a transaction, where a duplicate key
 * would abort the whole thing; a concurrent insert of the same key makes the server retry the
 * transaction instead.
 */
export async function insertOnce<T extends Document>(
  collection: Collection<T>,
  filter: Filter<T>,
  doc: OptionalUnlessRequiredId<T>,
): Promise<boolean> {
  const result = await collection.updateOne(filter, { $setOnInsert: doc } as UpdateFilter<T>, {
    upsert: true,
  });
  return result.upsertedCount === 1;
}
