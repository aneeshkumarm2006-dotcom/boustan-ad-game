/**
 * Applies pending migrations from db/migrations: `npm run db:migrate`. Uses
 * DATABASE_URL_MIGRATIONS (Supabase session pooler) when set, else DATABASE_URL.
 */
import { migrateDb } from "../db/migrate";
import { fail, loadLocalEnv, scriptDatabaseUrl } from "./local-env";

async function main() {
  loadLocalEnv();
  const url = scriptDatabaseUrl();
  await migrateDb(url);
  console.log(`Migrations applied to ${new URL(url).host}${new URL(url).pathname}`);
}

main().catch(fail);
