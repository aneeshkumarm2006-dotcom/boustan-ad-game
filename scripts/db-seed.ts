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
import { createDb } from "../db/client";
import { newAdminAudit, newCode } from "../db/schema";
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
      const names = { fr: fr.t(`reward.${id}.name`), en: en.t(`reward.${id}.name`) };
      const terms = { fr: fr.t(`reward.${id}.terms`), en: en.t(`reward.${id}.terms`) };
      // A new reward gets the defaults; an existing one only has its texts refreshed.
      await db.rewards.updateOne(
        { _id: id },
        {
          $set: { names, terms, updatedAt: new Date() },
          $setOnInsert: {
            rule:
              id === "free_coke"
                ? { distanceM: DEFAULT_REWARD_RULES.free_coke.distanceM }
                : { garlic: DEFAULT_REWARD_RULES.free_garlic_sauce.garlic },
            active: true,
            validityDays: 30,
            validUntil: null,
            maxPerPlayer: 1,
            alertThresholds: [20, 5],
            alertLevel: null,
            sortOrder: i,
          },
        },
        { upsert: true },
      );
    }
    console.log(`Rewards: ${REWARD_IDS.join(", ")}`);

    if (open) {
      const now = new Date();
      const startsAt = new Date(now.getTime() - 60_000);
      const endsAt = new Date(now.getTime() + 30 * 86_400_000);
      await db.campaignSettings.updateOne(
        { _id: 1 },
        {
          $set: { startsAt, endsAt, claimsEnabled: true, updatedAt: now, updatedBy: actor },
          $setOnInsert: { alertEmails: [], retentionDays: 90 },
        },
        { upsert: true },
      );
      await db.adminAudit.insertOne(
        newAdminAudit({
          adminEmail: actor,
          action: "campaign.seed_open",
          target: "campaign_settings",
          details: { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
        }),
      );
      console.log(`Campaign open until ${endsAt.toISOString()}, claims on`);
    }

    if (testCodes > 0) {
      const batch = `test-${new Date().toISOString().slice(0, 10)}`;
      for (const id of REWARD_IDS) {
        const rows = Array.from({ length: testCodes }, () =>
          newCode({ rewardId: id, code: testCode(), batch }),
        );
        for (let i = 0; i < rows.length; i += 500) {
          // A code that already exists is left alone.
          await db.codes.bulkWrite(
            rows.slice(i, i + 500).map((doc) => ({
              updateOne: {
                filter: { code: doc.code },
                update: { $setOnInsert: doc },
                upsert: true,
              },
            })),
            { ordered: false },
          );
        }
      }
      await db.adminAudit.insertOne(
        newAdminAudit({
          adminEmail: actor,
          action: "codes.seed_test",
          target: "codes",
          details: { perReward: testCodes, batch },
        }),
      );
      console.log(`Added ${testCodes} TEST- codes per reward (batch ${batch})`);
    }
  } finally {
    await client.close();
  }
}

main().catch(fail);
