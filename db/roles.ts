/**
 * Least-privilege database user for the app (NFR-06): what the API reads and writes, and nothing
 * else. No createCollection, createIndex, collMod or drop, so a leaked app credential can't
 * change the schema, and no `update` on the consent log or the audit log, which are append-only.
 *
 * Run `npm run db:migrate` first (with the admin user), then give the app this role:
 * - Atlas: Database Access > Custom Roles > Add, one privilege per row of APP_PRIVILEGES on
 *   the database, then a database user holding only that role (INFRA.md 4.3).
 * - Your own MongoDB: `npm run db:roles -- <password>` (scripts/db-roles.ts) creates the role and
 *   the user.
 *
 * A migration that adds a collection must add it here in the same change.
 *
 * Consents allow `remove` because erasing a player (DATA-07) and the retention job (DATA-06)
 * delete them. MongoDB can't make that conditional the way a trigger could, so the app keeps it
 * to those two code paths (lib/server/admin/players.ts) and no code updates a consent.
 */
import type { Db as MongoDb } from "mongodb";
import { COLLECTIONS, type CollectionKey } from "./schema";

export const APP_ROLE = "boustanApp";
export const APP_USER = "boustan_app";

const READ_WRITE = ["find", "insert", "update"];
const APPEND_ONLY = ["find", "insert"];

export const APP_PRIVILEGES: Record<CollectionKey, string[]> = {
  players: READ_WRITE,
  playerTokens: [...READ_WRITE, "remove"],
  consents: [...APPEND_ONLY, "remove"],
  runs: READ_WRITE,
  bestRuns: [...READ_WRITE, "remove"],
  // The admin edits settings and rewards; the rows themselves are created by migrations and seeds.
  campaignSettings: ["find", "update"],
  rewards: ["find", "update"],
  codes: READ_WRITE,
  claims: [...READ_WRITE, "remove"],
  emailOutbox: READ_WRITE,
  crmOutbox: READ_WRITE,
  events: APPEND_ONLY,
  eventsDaily: READ_WRITE,
  adminAudit: APPEND_ONLY,
};

/** The role's privileges in the shape MongoDB's createRole and Atlas custom roles use. */
export function appPrivileges(database: string) {
  return (Object.keys(COLLECTIONS) as CollectionKey[]).map((key) => ({
    resource: { db: database, collection: COLLECTIONS[key] },
    actions: APP_PRIVILEGES[key],
  }));
}

const ROLE_EXISTS = 51002;
const USER_EXISTS = 51003;
const hasCode = (error: unknown, code: number) => (error as { code?: number }).code === code;

/**
 * Creates the app role and its user on a MongoDB you run yourself (Atlas doesn't allow these
 * commands: use its console). Safe to repeat: the role's privileges and the user's password are
 * reset. Needs an admin connection.
 */
export async function createAppUser(mongo: MongoDb, password: string): Promise<void> {
  const privileges = appPrivileges(mongo.databaseName);
  try {
    await mongo.command({ createRole: APP_ROLE, privileges, roles: [] });
  } catch (error) {
    if (!hasCode(error, ROLE_EXISTS)) throw error;
    await mongo.command({ updateRole: APP_ROLE, privileges, roles: [] });
  }
  const roles = [{ role: APP_ROLE, db: mongo.databaseName }];
  try {
    await mongo.command({ createUser: APP_USER, pwd: password, roles });
  } catch (error) {
    if (!hasCode(error, USER_EXISTS)) throw error;
    await mongo.command({ updateUser: APP_USER, pwd: password, roles });
  }
}
