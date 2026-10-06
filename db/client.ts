/**
 * Postgres connections through postgres.js and Drizzle (NFR-04). The app connects to Supabase's
 * transaction pooler, which can't hold prepared statements, so `prepare` is off. Scripts and
 * migrations use the session pooler (DATABASE_URL_MIGRATIONS).
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>["db"];
/** A transaction handle, as passed to db.transaction callbacks. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything that can run queries: the pool or an open transaction. */
export type Queryable = Db | Tx;

export interface DbOptions {
  /** Connections per server instance. The pooler multiplexes them across instances. */
  max?: number;
}

export function createDb(url: string, { max = 5 }: DbOptions = {}) {
  const client = postgres(url, {
    max,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    // Keep timestamps and numerics as JS values Drizzle expects; no notices in the logs.
    onnotice: () => {},
  });
  return { db: drizzle(client, { schema }), client };
}
