/**
 * Seeds the reward catalogue (§5.1), and optionally opens the campaign and adds a test code
 * pool, for dev and preview databases.
 *
 *   npm run db:seed                              catalogue only (safe anywhere, re-runnable)
 *   npm run db:seed -- --open                    campaign live from now for 30 days, claims on
 *   npm run db:seed -- --test-codes 200          200 worthless TEST- codes per reward
 *
 * Test codes are refused when VERCEL_ENV=production. Re-running never touches thresholds or
 * active flags someone changed since.
 */
import { randomBytes } from "node:crypto";
import os from "node:os";
import { eq, sql } from "drizzle-orm";
import { createDb } from "../db/client";
import { adminAudit, campaignSettings, codes, rewards } from "../db/schema";
import { DEFAULT_REWARD_RULES, REWARD_IDS } from "../game-core";
import { createTranslator } from "../i18n";
import { fail, loadLocalEnv, scriptDatabaseUrl } from "./local-env";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function testCode(): string {
  const chars = Array.from(randomBytes(8), (b) => CROCKFORD[b & 31]).join("");
  return `TEST-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? "") : undefined;
}

async function main() {
  loadLocalEnv();
  const open = process.argv.includes("--open");
  const testCodes = Number(arg("--test-codes") ?? 0);
  if (testCodes > 0 && process.env.VERCEL_ENV === "production") {
    fail("Refusing to add test codes to production.");
  }
  const actor = `cli:${os.userInfo().username}`;
  const { db, client } = createDb(scriptDatabaseUrl(), { max: 1 });
  try {
    const fr = createTranslator("fr");
    const en = createTranslator("en");
    for (const [i, id] of REWARD_IDS.entries()) {
      await db
        .insert(rewards)
        .values({
          id,
          names: { fr: fr.t(`reward.${id}.name`), en: en.t(`reward.${id}.name`) },
          terms: { fr: fr.t(`reward.${id}.terms`), en: en.t(`reward.${id}.terms`) },
          rule:
            id === "free_coke"
              ? { distanceM: DEFAULT_REWARD_RULES.free_coke.distanceM }
              : { garlic: DEFAULT_REWARD_RULES.free_garlic_sauce.garlic },
          validityDays: 30,
          sortOrder: i,
        })
        .onConflictDoUpdate({
          target: rewards.id,
          set: { names: sql`excluded.names`, terms: sql`excluded.terms`, updatedAt: new Date() },
        });
    }
    console.log(`Rewards: ${REWARD_IDS.join(", ")}`);

    if (open) {
      const now = new Date();
      const startsAt = new Date(now.getTime() - 60_000);
      const endsAt = new Date(now.getTime() + 30 * 86_400_000);
      await db
        .update(campaignSettings)
        .set({ startsAt, endsAt, claimsEnabled: true, updatedAt: now, updatedBy: actor })
        .where(eq(campaignSettings.id, 1));
      await db.insert(adminAudit).values({
        adminEmail: actor,
        action: "campaign.seed_open",
        target: "campaign_settings",
        details: { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
      });
      console.log(`Campaign open until ${endsAt.toISOString()}, claims on`);
    }

    if (testCodes > 0) {
      const batch = `test-${new Date().toISOString().slice(0, 10)}`;
      for (const id of REWARD_IDS) {
        const rows = Array.from({ length: testCodes }, () => ({
          rewardId: id,
          code: testCode(),
          batch,
        }));
        for (let i = 0; i < rows.length; i += 500) {
          await db
            .insert(codes)
            .values(rows.slice(i, i + 500))
            .onConflictDoNothing();
        }
      }
      await db.insert(adminAudit).values({
        adminEmail: actor,
        action: "codes.seed_test",
        target: "codes",
        details: { perReward: testCodes, batch },
      });
      console.log(`Added ${testCodes} TEST- codes per reward (batch ${batch})`);
    }
  } finally {
    await client.end();
  }
}

main().catch(fail);
