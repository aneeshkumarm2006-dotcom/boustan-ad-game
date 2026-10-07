/**
 * Helpers for the db test project: a connection to the test database, a reset between tests,
 * an open contest, runs that pass validation, and players placed straight on the leaderboard.
 */
import { randomUUID } from "node:crypto";
import { inject } from "vitest";
import { createDb, type Db } from "@/db/client";
import {
  COLLECTIONS,
  newCampaignSettings,
  newPlayer,
  type BestRunDoc,
  type PlayerDoc,
} from "@/db/schema";
import { TUNING, createLevel, distanceMAt, pointsOf } from "@/game-core";
import { clearBoardCache } from "@/lib/server/leaderboard";
import { clearCampaignCache } from "@/lib/server/campaign";
import { setDbForTests } from "@/lib/server/db";
import { resetMemoryLimitsForTests } from "@/lib/server/rate-limit";
import { finishRun } from "@/lib/server/runs";
import { saveScore, type SaveInput, type SaveSuccess } from "@/lib/server/scores";
import { signToken } from "@/lib/server/tokens";

export function connect(max = 10): { db: Db; close: () => Promise<void> } {
  const { db, client } = createDb(inject("databaseUrl"), { max });
  setDbForTests(db);
  return { db, close: () => client.close() };
}

/** Empties every collection. The campaign settings document goes too; seedCampaign adds it. */
export async function resetDb(db: Db): Promise<void> {
  for (const name of Object.values(COLLECTIONS)) {
    await db.mongo.collection(name).deleteMany({});
  }
  clearCampaignCache();
  clearBoardCache();
  resetMemoryLimitsForTests();
}

/** Adds the settings document: a contest that started an hour ago and ends in 30 days. */
export async function seedCampaign(
  db: Db,
  { open = true, endsAt }: { open?: boolean; endsAt?: Date | null } = {},
): Promise<void> {
  const now = Date.now();
  await db.campaignSettings.insertOne(
    newCampaignSettings({
      startsAt: new Date(now - 3_600_000),
      endsAt: endsAt === undefined ? new Date(now + 30 * 86_400_000) : endsAt,
      leaderboardOpen: open,
    }),
  );
  clearCampaignCache();
}

export interface HonestRun {
  seed: number;
  distance: number;
  garlic: number;
  hits: number;
  activeMs: number;
}

/**
 * A run an honest client could report: the curve's distance for `seconds`, and garlic and hits
 * no higher than the level spawned.
 */
export function honestRun(seed: number, seconds: number, garlic = 0, hits = 0): HonestRun {
  const activeMs = Math.round(seconds * 1000);
  const distance = distanceMAt(activeMs);
  const level = createLevel(seed);
  return {
    seed,
    distance,
    garlic: Math.min(garlic, level.garlicSpawnedUpTo(distance)),
    hits: Math.min(hits, level.obstaclesSpawnedUpTo(distance)),
    activeMs,
  };
}

/** What the server awards an honest run: whole metres of the curve plus 10 per garlic. */
export const pointsFor = (run: Pick<HonestRun, "activeMs" | "garlic">): number =>
  pointsOf({ distanceM: distanceMAt(run.activeMs), garlic: run.garlic });

/** A good run: 30 s and 12 garlic, a few hundred points. */
export const GOOD = (seed = 7) => honestRun(seed, 30, 12, 1);
/** A short run: 8 s and 2 garlic, a few dozen points. */
export const SHORT = (seed = 9) => honestRun(seed, 8, 2, 1);

export function runTokenFor(
  run: Pick<HonestRun, "seed" | "activeMs">,
  opts: { id?: string; issuedAt?: number } = {},
) {
  const id = opts.id ?? randomUUID();
  const token = signToken("run", {
    v: 1,
    id,
    seed: run.seed,
    iat: opts.issuedAt ?? Date.now() - run.activeMs - 2000,
    tv: TUNING.version,
    lang: "fr",
    src: "test-src",
    host: "https://host.example",
    utm: { utm_campaign: "test" },
  });
  return { id, token };
}

/** Starts and finishes a run through the real service; returns its response and run id. */
export async function finish(db: Db, run: HonestRun, playerToken: string | null = null) {
  const { id, token } = runTokenFor(run);
  const { response } = await finishRun(
    db,
    id,
    { token, distance: run.distance, garlic: run.garlic, hits: run.hits, activeMs: run.activeMs },
    { playerToken, clientVersion: "test", now: new Date() },
  );
  return { runId: id, ...response };
}

export const ctx = () => ({ ip: "203.0.113.7", userAgent: "vitest", now: new Date() });

/** Saves a finished run's score for `email` through the real service; throws if it fails. */
export async function save(
  db: Db,
  finished: { saveToken: string | null },
  email: string,
  extra: Partial<Omit<SaveInput, "saveToken" | "email">> = {},
): Promise<SaveSuccess> {
  const result = await saveScore(
    db,
    {
      saveToken: finished.saveToken!,
      email,
      lang: "en",
      termsAge: true,
      marketingOptIn: false,
      src: "test-src",
      utm: {},
      ...extra,
    },
    ctx(),
  );
  if (!result.ok) throw new Error(`save failed: ${result.error}`);
  return result;
}

/**
 * Puts a player on the leaderboard directly, with a best run worth `points`, without playing a
 * run. `achievedAt` breaks ties between equal points (earlier wins).
 */
export async function addRanked(
  db: Db,
  {
    email,
    nickname = null,
    points,
    garlic = 0,
    achievedAt = new Date(),
    hidden = false,
    ...overrides
  }: {
    email: string;
    nickname?: string | null;
    points: number;
    garlic?: number;
    achievedAt?: Date;
    hidden?: boolean;
  } & Partial<PlayerDoc>,
): Promise<{ player: PlayerDoc; best: BestRunDoc }> {
  const player = newPlayer({
    email,
    emailNormalized: email.toLowerCase(),
    language: "en",
    nickname,
    hidden,
    ...overrides,
  });
  const best: BestRunDoc = {
    _id: player._id,
    runId: randomUUID(),
    points,
    distanceM: points - garlic * 10,
    garlic,
    achievedAt,
  };
  await db.players.insertOne(player);
  await db.bestRuns.insertOne(best);
  clearBoardCache();
  return { player, best };
}
