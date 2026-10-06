/**
 * A throwaway Postgres for development, no Docker or install needed: `npm run db:local`.
 * Data lives in ./.pgdata (git-ignored). Matches DATABASE_URL in .env.example. Ctrl+C stops it.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { fail } from "./local-env";

const PORT = Number(process.env.LOCAL_DB_PORT ?? 54339);
const DIR = path.resolve(".pgdata");
const NAME = "boustan";

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: DIR,
    user: "postgres",
    password: "postgres",
    port: PORT,
    persistent: true,
    // Windows defaults the cluster to WIN1252; names and emails need UTF-8 (as on Supabase).
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
  });
  if (!existsSync(path.join(DIR, "PG_VERSION"))) await pg.initialise();
  await pg.start();
  await pg.createDatabase(NAME).catch(() => {}); // already there
  console.log(`Postgres ready: postgres://postgres:postgres@localhost:${PORT}/${NAME}`);
  console.log("Next: npm run db:migrate && npm run db:seed -- --open --test-codes 200");
  const stop = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch(fail);
