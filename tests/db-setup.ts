/**
 * Global setup for the db test project: a fresh MongoDB replica set (transactions need one)
 * with every migration applied. TEST_MONGODB_URI (CI's service container) is used when set;
 * otherwise an in-memory server starts and is thrown away afterwards. The first run downloads
 * the MongoDB server binary, which is cached after that.
 */
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import type { TestProject } from "vitest/node";
import { migrateDb } from "../db/migrate";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

export default async function setup(project: TestProject) {
  let url = process.env.TEST_MONGODB_URI;
  let stop = async () => {};
  if (!url) {
    const rs = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    url = rs.getUri("test");
    stop = async () => {
      await rs.stop();
    };
  }
  await migrateDb(url);
  project.provide("databaseUrl", url);
  return stop;
}
