import { createDb, type Db } from "@/db/client";
import { env } from "./env";

/** One connection pool per server instance, kept across hot reloads in dev. */
const store = globalThis as unknown as { __boustanDb?: Db };

export function db(): Db {
  if (!store.__boustanDb) {
    const e = env();
    store.__boustanDb = createDb(e.MONGODB_URI, { max: e.MONGODB_POOL_MAX }).db;
  }
  return store.__boustanDb;
}

/** Tests point the app at their own database. */
export function setDbForTests(value: Db | undefined): void {
  store.__boustanDb = value;
}
