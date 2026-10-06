import { sql } from "drizzle-orm";
import postgres from "postgres";
import { createDb } from "../db/client";
import { migrateDb } from "../db/migrate";
import { campaignSettings, codes, rewards } from "../db/schema";
import { LIVE_DATABASE_URL } from "../playwright.live.config";

/** A fresh e2e database: migrated, emptied, campaign open, 20 test codes per reward. */
export default async function globalSetup() {
  const url = new URL(LIVE_DATABASE_URL);
  const name = url.pathname.slice(1);
  const admin = postgres({ ...pgOptions(url), database: "postgres", max: 1, onnotice: () => {} });
  const exists = await admin`select 1 from pg_database where datname = ${name}`;
  if (exists.length === 0) await admin.unsafe(`create database "${name}"`);
  await admin.end();

  await migrateDb(LIVE_DATABASE_URL);
  const { db, client } = createDb(LIVE_DATABASE_URL, { max: 1 });
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local boustan.allow_consent_purge = 'on'`);
    await tx.execute(
      sql.raw(`truncate events_daily, events, admin_audit, crm_outbox, email_outbox, claims, codes,
        best_runs, consents, player_tokens, runs, players, rewards, campaign_settings
        restart identity cascade`),
    );
  });
  const now = Date.now();
  await db.insert(campaignSettings).values({
    id: 1,
    startsAt: new Date(now - 3_600_000),
    endsAt: new Date(now + 86_400_000),
    claimsEnabled: true,
  });
  await db.insert(rewards).values([
    {
      id: "free_coke",
      names: { fr: "Coke gratuit", en: "Free Coke" },
      terms: { fr: "", en: "" },
      rule: { distanceM: 100 },
      validityDays: 30,
    },
    {
      id: "free_garlic_sauce",
      names: { fr: "Sauce à l'ail gratuite", en: "Free garlic sauce" },
      terms: { fr: "", en: "" },
      rule: { garlic: 10 },
      validityDays: 30,
    },
  ]);
  for (const reward of ["free_coke", "free_garlic_sauce"] as const) {
    await db.insert(codes).values(
      Array.from({ length: 20 }, (_, i) => ({
        rewardId: reward,
        code: `E2E-${reward === "free_coke" ? "COKE" : "GARL"}-${String(i).padStart(3, "0")}`,
      })),
    );
  }
  await client.end();
}

function pgOptions(url: URL) {
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}
