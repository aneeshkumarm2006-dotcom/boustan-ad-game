/**
 * Contest switches without a redeploy (SEC-08, ADM-07). The admin campaign page edits the same
 * fields; this keeps working when nobody can sign in. Every change is written to admin_audit
 * (SEC-09). The same fields can also be edited in Atlas or mongosh, without the audit trail.
 *
 *   npm run campaign -- status
 *   npm run campaign -- board on|off                     the leaderboard switch
 *   npm run campaign -- dates 2026-10-15T00:00-04:00 2026-11-15T00:00-05:00   ("none" clears)
 *
 * Scores count only while the contest window is open and the leaderboard is on; the game stays
 * playable either way. The end date is when the top 3 become final. A switch applies to saves at
 * once (the run-start cache can show the old state for up to 5 s).
 */
import os from "node:os";
import { createDb } from "../db/client";
import { newAdminAudit, type CampaignSettingsDoc } from "../db/schema";
import { WINNERS } from "../game-core";
import { topEntries } from "../lib/server/leaderboard";
import { fail, loadLocalEnv, scriptDatabaseUrl } from "./local-env";

const USAGE = "Usage: npm run campaign -- status | board on|off | dates <start|none> <end|none>";

function onOff(value: string | undefined): boolean {
  if (value === "on") return true;
  if (value === "off") return false;
  return fail(USAGE);
}

function date(value: string | undefined): Date | null {
  if (value === "none") return null;
  const d = new Date(value ?? "");
  if (Number.isNaN(d.getTime())) fail(`Not a date: "${value}". Use ISO 8601 with an offset.`);
  return d;
}

/** Whether a score counts right now, and if not, why (the same rule as lib/server/campaign.ts). */
function scoresCount(s: CampaignSettingsDoc | null, now: Date): string {
  if (!s) return "no (no settings document: run `npm run db:migrate`)";
  if (s.startsAt && now < s.startsAt) return "no (the contest has not started)";
  if (s.endsAt && now >= s.endsAt) return "no (the contest has ended)";
  return s.leaderboardOpen ? "yes" : "no (the leaderboard is off)";
}

async function main() {
  loadLocalEnv();
  const [command, a, b] = process.argv.slice(2);
  const actor = process.env.CAMPAIGN_ACTOR || `cli:${os.userInfo().username}`;
  const { db, client } = createDb(scriptDatabaseUrl(), { max: 1 });
  const audit = (action: string, details: Record<string, unknown>) =>
    db.adminAudit.insertOne(
      newAdminAudit({ adminEmail: actor, action, target: "campaign_settings", details }),
    );
  const settings = async (set: Partial<CampaignSettingsDoc>) => {
    const result = await db.campaignSettings.updateOne(
      { _id: 1 },
      { $set: { ...set, updatedAt: new Date(), updatedBy: actor } },
    );
    if (result.matchedCount === 0) fail("No settings document yet: run `npm run db:migrate`.");
  };
  try {
    switch (command) {
      case "status":
        break;
      case "board": {
        const leaderboardOpen = onOff(a);
        await settings({ leaderboardOpen });
        await audit("campaign.leaderboard", { leaderboardOpen });
        break;
      }
      case "dates": {
        const startsAt = date(a);
        const endsAt = date(b);
        if (startsAt && endsAt && endsAt <= startsAt) fail("The end must be after the start.");
        await settings({ startsAt, endsAt });
        await audit("campaign.dates", {
          startsAt: startsAt?.toISOString() ?? null,
          endsAt: endsAt?.toISOString() ?? null,
        });
        break;
      }
      default:
        fail(USAGE);
    }

    const s = await db.campaignSettings.findOne({ _id: 1 });
    console.log("Contest");
    console.log(`  starts:       ${s?.startsAt?.toISOString() ?? "(not set)"}`);
    console.log(`  ends:         ${s?.endsAt?.toISOString() ?? "(not set: it never ends)"}`);
    console.log(`  leaderboard:  ${s?.leaderboardOpen ? "ON" : "OFF"}`);
    console.log(`  scores count: ${scoresCount(s, new Date())}`);
    const top = await topEntries(db, WINNERS);
    console.log(`Top ${WINNERS} (the winners)`);
    if (top.length === 0) console.log("  nobody yet");
    for (const e of top) console.log(`  ${e.rank}  ${e.name}  ${e.points} points`);
  } finally {
    await client.close();
  }
}

main().catch(fail);
