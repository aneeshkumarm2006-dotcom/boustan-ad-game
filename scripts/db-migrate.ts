/**
 * Applies pending migrations from db/migrations.ts: `npm run db:migrate`. Uses
 * MONGODB_URI_MIGRATIONS (an admin user) when set, else MONGODB_URI.
 */
import { migrateDb } from "../db/migrate";
import { describeUrl, fail, loadLocalEnv, scriptDatabaseUrl } from "./local-env";

async function main() {
  loadLocalEnv();
  const url = scriptDatabaseUrl();
  const applied = await migrateDb(url);
  console.log(
    applied.length > 0
      ? `Applied ${applied.join(", ")} to ${describeUrl(url)}`
      : `Nothing to apply: ${describeUrl(url)} is up to date`,
  );
}

main().catch(fail);
