/**
 * Helpers for the db test project: a connection to the test database, a reset between tests,
 * a seeded campaign, and runs that pass validation.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { inject } from "vitest";
import { createDb, type Db } from "@/db/client";
import { campaignSettings, codes, rewards } from "@/db/schema";
import { TUNING, createLevel, distanceMAt, type RewardId } from "@/game-core";
import { clearCampaignCache } from "@/lib/server/campaign";
import { setDbForTests } from "@/lib/server/db";
import { resetMemoryLimitsForTests } from "@/lib/server/rate-limit";
import { finishRun } from "@/lib/server/runs";
import { signToken } from "@/lib/server/tokens";

export function connect(max = 10): { db: Db; close: () => Promise<void> } {
  const { db, client } = createDb(inject("databaseUrl"), { max });
  setDbForTests(db);
  return { db, close: () => client.end() };
}

const TABLES = [
  "events_daily",
  "events",
  "admin_audit",
  "crm_outbox",
  "email_outbox",
  "claims",
  "codes",
  "best_runs",
  "consents",
  "player_tokens",
  "runs",
  "players",
  "rewards",
  "campaign_settings",
];

export async function resetDb(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local boustan.allow_consent_purge = 'on'`);
    await tx.execute(sql.raw(`truncate ${TABLES.join(", ")} restart identity cascade`));
  });
  clearCampaignCache();
  resetMemoryLimitsForTests();
}

export async function seedCampaign(
  db: Db,
  { codesPerReward = 10, open = true }: { codesPerReward?: number; open?: boolean } = {},
): Promise<void> {
  const now = Date.now();
  await db.insert(campaignSettings).values({
    id: 1,
    startsAt: new Date(now - 3_600_000),
    endsAt: new Date(now + 30 * 86_400_000),
    claimsEnabled: open,
  });
  await db.insert(rewards).values([
    {
      id: "free_coke",
      names: { fr: "Coke gratuit", en: "Free Coke" },
      terms: { fr: "…", en: "…" },
      rule: { distanceM: 100 },
      validityDays: 30,
      sortOrder: 0,
    },
    {
      id: "free_garlic_sauce",
      names: { fr: "Sauce à l'ail gratuite", en: "Free garlic sauce" },
      terms: { fr: "…", en: "…" },
      rule: { garlic: 10 },
      validityDays: 30,
      sortOrder: 1,
    },
  ]);
  await addCodes(db, "free_coke", codesPerReward);
  await addCodes(db, "free_garlic_sauce", codesPerReward);
  clearCampaignCache();
}

export async function addCodes(db: Db, reward: RewardId, n: number, prefix = "C"): Promise<void> {
  if (n <= 0) return;
  const rows = Array.from({ length: n }, (_, i) => ({
    rewardId: reward,
    code: `${prefix}-${reward === "free_coke" ? "COKE" : "GARL"}-${String(i).padStart(4, "0")}`,
  }));
  await db.insert(codes).values(rows);
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

/** Both rewards: 100 m and 10 garlic. */
export const BOTH = (seed = 7) => honestRun(seed, 30, 12, 1);
/** Neither reward. */
export const NOTHING = (seed = 9) => honestRun(seed, 8, 2, 1);

export function runTokenFor(
  run: Pick<HonestRun, "seed" | "activeMs">,
  opts: { id?: string; issuedAt?: number; rules?: { distanceM: number; garlic: number } } = {},
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
    rules: opts.rules ?? { distanceM: 100, garlic: 10 },
  });
  return { id, token };
}

/** Starts and finishes a run through the real service; returns its claim token. */
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
