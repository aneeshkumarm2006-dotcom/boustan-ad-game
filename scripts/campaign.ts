/**
 * Campaign switches without a redeploy (SEC-08, ADM-07), until the admin screens exist. Every
 * change is written to admin_audit (SEC-09). The same fields can be edited in Atlas or
 * mongosh; this keeps the audit trail.
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
import { createDb } from "../db/client";
import { newAdminAudit, type CampaignSettingsDoc } from "../db/schema";
import { isRewardId } from "../game-core";
import { poolStats } from "../lib/server/admin/pools";
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
    db.adminAudit.insertOne(newAdminAudit({ adminEmail: actor, action, target, details }));
  const settings = (set: Partial<CampaignSettingsDoc>) =>
    db.campaignSettings.updateOne(
      { _id: 1 },
      { $set: { ...set, updatedAt: new Date(), updatedBy: actor } },
    );
  const reward = (id: string, set: Record<string, unknown>) =>
    db.rewards.updateOne({ _id: id }, { $set: { ...set, updatedAt: new Date() } });
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
        await reward(id, { active });
        await audit("reward.active", id, { active });
        break;
      }
      case "threshold": {
        const id = rewardId(a);
        const n = Number(b);
        if (!Number.isFinite(n) || n <= 0) fail("The threshold must be a positive number.");
        const rule = id === "free_coke" ? { distanceM: n } : { garlic: Math.round(n) };
        await reward(id, { rule });
        await audit("reward.threshold", id, rule);
        break;
      }
      case "validity": {
        const id = rewardId(a);
        const days = Number(b);
        if (!Number.isInteger(days) || days <= 0) fail("Validity is a whole number of days.");
        await reward(id, { validityDays: days });
        await audit("reward.validity", id, { validityDays: days });
        break;
      }
      default:
        fail(USAGE);
    }

    const s = await db.campaignSettings.findOne({ _id: 1 });
    console.log("Campaign");
    console.log(`  starts:  ${s?.startsAt?.toISOString() ?? "(not set)"}`);
    console.log(`  ends:    ${s?.endsAt?.toISOString() ?? "(not set)"}`);
    console.log(`  claims:  ${s?.claimsEnabled ? "ON" : "OFF"}`);
    const stock = await poolStats(db);
    const rules = await db.rewards.find().toArray();
    console.log("Rewards");
    for (const r of stock) {
      const rule = rules.find((x) => x._id === r.reward);
      console.log(
        `  ${r.reward.padEnd(18)} ${r.active ? "ON " : "OFF"}  rule ${JSON.stringify(rule?.rule)}  ` +
          `valid ${rule?.validityDays ?? "-"} d  codes ${r.available}/${r.total} left, ${r.assigned} issued`,
      );
    }
  } finally {
    await client.close();
  }
}

main().catch(fail);
