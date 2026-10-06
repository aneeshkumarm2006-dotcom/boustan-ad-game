import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Scripts, tests and Playwright all run from site/. (`import.meta.url` would be neater, but
 * Playwright loads this file as CommonJS.)
 */
export const MIGRATIONS_DIR = path.resolve("db/migrations");

/** Applies every pending migration in ./migrations. Needs a session-mode connection. */
export async function migrateDb(url: string): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await client.end();
  }
}
