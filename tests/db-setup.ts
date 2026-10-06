/**
 * Global setup for the db test project: a fresh Postgres with every migration applied.
 * TEST_DATABASE_URL (CI's service container) is used when set; otherwise an embedded server
 * starts in a temp directory and is thrown away afterwards.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { TestProject } from "vitest/node";
import { migrateDb } from "../db/migrate";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

export default async function setup(project: TestProject) {
  let url = process.env.TEST_DATABASE_URL;
  let stop = async () => {};
  if (!url) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "boustan-test-pg-"));
    const port = 55000 + Math.floor(Math.random() * 2000);
    const pg = new EmbeddedPostgres({
      databaseDir: dir,
      user: "postgres",
      password: "postgres",
      port,
      persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
      // The concurrency test opens many connections at once (AC-04).
      postgresFlags: ["-c", "max_connections=300", "-c", "fsync=off"],
      onLog: () => {},
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("test");
    url = `postgres://postgres:postgres@localhost:${port}/test`;
    stop = async () => {
      await pg.stop();
      await rm(dir, { recursive: true, force: true });
    };
  }
  await migrateDb(url);
  project.provide("databaseUrl", url);
  return stop;
}
