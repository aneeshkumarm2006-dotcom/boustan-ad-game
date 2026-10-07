/**
 * A throwaway MongoDB for development, no Docker or install needed: `npm run db:local`. It is a
 * one-node replica set, because transactions need one. The first run downloads the MongoDB
 * server binary (cached afterwards). Data lives in ./.mongodata (git-ignored). Matches
 * MONGODB_URI in .env.example. Ctrl+C stops it.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { fail } from "./local-env";

const PORT = Number(process.env.LOCAL_DB_PORT ?? 27019);
const DIR = path.resolve(".mongodata");
const NAME = "boustan";
const REPLICA_SET = "rs0";
const URL = `mongodb://127.0.0.1:${PORT}/${NAME}?replicaSet=${REPLICA_SET}&directConnection=true`;

/** Whether a server already answers on the port, such as one a closed terminal left behind. */
async function isRunning(): Promise<boolean> {
  const client = new MongoClient(`mongodb://127.0.0.1:${PORT}/?directConnection=true`, {
    serverSelectionTimeoutMS: 1500,
  });
  try {
    await client.db("admin").command({ ping: 1 });
    return true;
  } catch {
    return false;
  } finally {
    await client.close();
  }
}

async function main() {
  if (await isRunning()) {
    console.log(`MongoDB is already running: ${URL}`);
    console.log(
      "It is left over from an earlier `npm run db:local`. End the mongod process to restart it.",
    );
    return;
  }
  mkdirSync(DIR, { recursive: true });
  const rs = await MongoMemoryReplSet.create({
    replSet: { name: REPLICA_SET, count: 1, dbName: NAME, storageEngine: "wiredTiger" },
    instanceOpts: [{ port: PORT, dbPath: DIR, storageEngine: "wiredTiger" }],
  });
  console.log(`MongoDB ready: ${URL}`);
  console.log("Next: npm run db:migrate && npm run db:seed -- --open --demo 30");
  const stop = async () => {
    await rs.stop({ doCleanup: false });
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch(fail);
