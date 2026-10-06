/**
 * Creates the app's least-privilege role and user (db/roles.ts) on a MongoDB you run yourself.
 * Atlas doesn't allow this from a script: create the custom role and user in its console
 * instead (INFRA.md 4.3). Run it after `npm run db:migrate`, as an admin user:
 *
 *   npm run db:roles -- <password, at least 16 characters>
 *
 * Re-running resets the role's privileges and the user's password. Then point MONGODB_URI at
 * the new user: mongodb://boustan_app:<password>@<host>/<database>?authSource=<database>
 */
import { createDb } from "../db/client";
import { APP_ROLE, APP_USER, createAppUser } from "../db/roles";
import { describeUrl, fail, loadLocalEnv, scriptDatabaseUrl } from "./local-env";

async function main() {
  loadLocalEnv();
  const password = process.argv[2];
  if (!password || password.length < 16) {
    fail("Usage: npm run db:roles -- <password, at least 16 characters>");
  }
  const url = scriptDatabaseUrl();
  const { db, client } = createDb(url, { max: 1 });
  try {
    await createAppUser(db.mongo, password);
    const database = db.mongo.databaseName;
    console.log(`Role ${APP_ROLE} and user ${APP_USER} are set on ${describeUrl(url)}`);
    console.log(
      `MONGODB_URI=mongodb://${APP_USER}:<password>@<host>/${database}?authSource=${database}`,
    );
  } finally {
    await client.close();
  }
}

main().catch(fail);
