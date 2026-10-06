/**
 * Campaign switches without a redeploy (SEC-08, ADM-07), until the admin screens exist. Every
 * change is written to admin_audit (SEC-09). The same columns can be edited in Supabase Studio;
 * this keeps the audit trail.
 *
 *   npm run campaign -- status
 *   npm run campaign -- claims on|off                    global kill switch
 *   npm run campaign -- reward free_coke on|off          per-reward kill switch
 *   npm run campaign -- threshold free_coke 120          metres (Coke) or garlic (sauce)
 *   npm run campaign -- validity free_coke 30            days a code stays valid after issue
 *   npm run campaign -- dates 2026-10-15T00:00-04:00 2026-11-15T00:00-05:00   ("none" clears)
 *
 * Thresholds apply to runs started after the change; switches apply to claims at once (the
 * run-start cache can show the old state for up to 5 s).
 */
import os from "node:os";
import { eq, sql } from "drizzle-orm";
import { createDb } from "../db/client";
import { adminAudit, campaignSettings, rewards } from "../db/schema";
import { isRewardId } from "../game-core";
import { fail, loadLocalEnv, scriptDatabaseUrl } from "./local-env";

const USAGE = `Usage: npm run campaign -- status | claims on|off | reward <id> on|off |
  threshold <id> <n> | validity <id> <days> | dates <start|none> <end|none>`;

function onOff(value: string | undefined): boolean {
  if (value === "on") return true;
  if (value === "off") return false;
  return fail(USAGE);
}

function rewardId(value: string | undefined) {
  if (!isRewardId(value)) fail(`Unknown reward "${value}". Use free_coke or free_garlic_sauce.`);
  return value;
}

function date(value: string | undefined): Date | null {
  if (value === "none") return null;
  const d = new Date(value ?? "");
  if (Number.isNaN(d.getTime())) fail(`Not a date: "${value}". Use ISO 8601 with an offset.`);
  return d;
}

async function main() {
  loadLocalEnv();
  const [command, a, b] = process.argv.slice(2);
  const actor = process.env.CAMPAIGN_ACTOR || `cli:${os.userInfo().username}`;
  const { db, client } = createDb(scriptDatabaseUrl(), { max: 1 });
  const audit = (action: string, target: string, details: Record<string, unknown>) =>
    db.insert(adminAudit).values({ adminEmail: actor, action, target, details });
  const settings = (set: Partial<typeof campaignSettings.$inferInsert>) =>
    db
      .update(campaignSettings)
      .set({ ...set, updatedAt: new Date(), updatedBy: actor })
      .where(eq(campaignSettings.id, 1));
  try {
    switch (command) {
      case "status":
        break;
      case "claims": {
        const on = onOff(a);
        await settings({ claimsEnabled: on });
        await audit("campaign.claims", "campaign_settings", { claimsEnabled: on });
        break;
      }
      case "dates": {
        const startsAt = date(a);
        const endsAt = date(b);
        if (startsAt && endsAt && endsAt <= startsAt) fail("The end must be after the start.");
        await settings({ startsAt, endsAt });
        await audit("campaign.dates", "campaign_settings", {
          startsAt: startsAt?.toISOString() ?? null,
          endsAt: endsAt?.toISOString() ?? null,
        });
        break;
      }
      case "reward": {
        const id = rewardId(a);
        const active = onOff(b);
        await db.update(rewards).set({ active, updatedAt: new Date() }).where(eq(rewards.id, id));
        await audit("reward.active", id, { active });
        break;
      }
      case "threshold": {
        const id = rewardId(a);
        const n = Number(b);
        if (!Number.isFinite(n) || n <= 0) fail("The threshold must be a positive number.");
        const rule = id === "free_coke" ? { distanceM: n } : { garlic: Math.round(n) };
        await db.update(rewards).set({ rule, updatedAt: new Date() }).where(eq(rewards.id, id));
        await audit("reward.threshold", id, rule);
        break;
      }
      case "validity": {
        const id = rewardId(a);
        const days = Number(b);
        if (!Number.isInteger(days) || days <= 0) fail("Validity is a whole number of days.");
        await db
          .update(rewards)
          .set({ validityDays: days, updatedAt: new Date() })
          .where(eq(rewards.id, id));
        await audit("reward.validity", id, { validityDays: days });
        break;
      }
      default:
        fail(USAGE);
    }

    const [s] = await db.select().from(campaignSettings).where(eq(campaignSettings.id, 1));
    console.log("Campaign");
    console.log(`  starts:  ${s?.startsAt?.toISOString() ?? "(not set)"}`);
    console.log(`  ends:    ${s?.endsAt?.toISOString() ?? "(not set)"}`);
    console.log(`  claims:  ${s?.claimsEnabled ? "ON" : "OFF"}`);
    const stock = await db.execute<{
      reward_id: string;
      active: boolean;
      total: number;
      available: number;
      assigned: number;
    }>(
      sql`select reward_id, active, total::int, available::int, assigned::int from v_code_stock order by reward_id`,
    );
    const rules = await db
      .select({ id: rewards.id, rule: rewards.rule, validityDays: rewards.validityDays })
      .from(rewards);
    console.log("Rewards");
    for (const r of stock) {
      const rule = rules.find((x) => x.id === r.reward_id);
      console.log(
        `  ${r.reward_id.padEnd(18)} ${r.active ? "ON " : "OFF"}  rule ${JSON.stringify(rule?.rule)}  ` +
          `valid ${rule?.validityDays ?? "-"} d  codes ${r.available}/${r.total} left, ${r.assigned} issued`,
      );
    }
  } finally {
    await client.end();
  }
}

main().catch(fail);
