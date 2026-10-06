import { createDb } from "./client";
import { runMigrations } from "./migrations";

/**
 * Applies every pending migration (./migrations.ts). Needs a user that can create collections
 * and indexes: the migrations URL, not the app's least-privilege one. Returns the ids applied.
 */
export async function migrateDb(url: string): Promise<string[]> {
  const { db, client } = createDb(url, { max: 1 });
  try {
    return await runMigrations(db);
  } finally {
    await client.close();
  }
}
