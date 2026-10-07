/**
 * Prepares a dev or preview database: makes sure the settings document exists, and optionally
 * opens the contest and fills the leaderboard with demo players.
 *
 *   npm run db:seed                         settings document only (safe anywhere, re-runnable)
 *   npm run db:seed -- --open               contest live from a minute ago for 30 days, leaderboard on
 *   npm run db:seed -- --demo 30            also add 30 demo players with scores, flagged runs and
 *                                           ten days of funnel events, to show a client
 *
 * The migrations already create the settings document, so a plain seed only covers a database
 * that skipped them. Demo players all have an address ending in @demo.example; they are refused
 * when VERCEL_ENV=production and when they are already there. Re-running --open resets the dates
 * and switches the leaderboard on, and nothing else.
 */
import { randomUUID } from "node:crypto";
import os from "node:os";
import { createDb, type Db } from "../db/client";
import {
  newAdminAudit,
  newCampaignSettings,
  newConsent,
  newEvent,
  newPlayer,
  newRun,
  type BestRunDoc,
  type ConsentDoc,
  type EventDoc,
  type PlayerDoc,
  type RunDoc,
} from "../db/schema";
import { TUNING, WINNERS, createLevel, distanceMAt, scoreOf } from "../game-core";
import type { ClientEvent } from "../lib/analytics-events";
import { montrealDay, rollupEvents } from "../lib/server/analytics";
import { consentText, type ConsentKind } from "../lib/server/consent";
import { topEntries } from "../lib/server/leaderboard";
import { autoNickname } from "../lib/nicknames";
import { fail, loadLocalEnv, scriptDatabaseUrl } from "./local-env";

const DAY = 86_400_000;
const DEMO_DAYS = 10;
/** Matches the address of every demo player (a regular expression, as the driver wants it). */
const DEMO_EMAIL = "@demo\\.example$";
const SRCS = [
  "lapresse",
  "journaldemontreal",
  "boustan-site",
  "instagram",
  "share",
  "tva-nouvelles",
];
const SRC_WEIGHT = [26, 22, 20, 18, 9, 5];
const DEVICES = ["mobile", "mobile", "mobile", "mobile", "desktop", "desktop", "tablet"];
/** Point milestones the funnel shows (TUNING.milestonesPts, then every 100). */
const MILESTONES = [...TUNING.milestonesPts, 300, 400, 500];

// A small seeded generator, so a demo looks the same every time it is made.
let state = 20261015;
function rand(): number {
  state = (state * 1664525 + 1013904223) >>> 0;
  return state / 0x1_0000_0000;
}
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
function weighted(): string {
  let r = rand() * SRC_WEIGHT.reduce((a, b) => a + b, 0);
  for (let i = 0; i < SRCS.length; i++) {
    r -= SRC_WEIGHT[i];
    if (r < 0) return SRCS[i];
  }
  return SRCS[0];
}

/** `--demo <n>`: how many demo players to add; 0 when the flag is absent. */
function demoCount(): number {
  const i = process.argv.indexOf("--demo");
  if (i < 0) return 0;
  const n = Number(process.argv[i + 1]);
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    fail("--demo takes a number of players from 1 to 1000, for example: --demo 30");
  }
  return n;
}

/** Opens the contest: it started a minute ago, ends in 30 days, and the leaderboard is on. */
async function openContest(db: Db, actor: string) {
  const now = new Date();
  const startsAt = new Date(now.getTime() - 60_000);
  const endsAt = new Date(now.getTime() + 30 * DAY);
  await db.campaignSettings.updateOne(
    { _id: 1 },
    {
      $set: { startsAt, endsAt, leaderboardOpen: true, updatedAt: now, updatedBy: actor },
      $setOnInsert: { retentionDays: 90 },
    },
    { upsert: true },
  );
  await db.adminAudit.insertOne(
    newAdminAudit({
      adminEmail: actor,
      action: "campaign.seed_open",
      target: "campaign_settings",
      details: {
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        leaderboardOpen: true,
      },
    }),
  );
  console.log(`Contest open until ${endsAt.toISOString()}, leaderboard on`);
}

/**
 * Believable players for a demo: each has an honest run of the speed curve saved as their best,
 * their consent rows and a source, language and opt-in. A few flagged runs and ten days of
 * funnel events fill the admin dashboard.
 */
async function addDemoPlayers(db: Db, count: number) {
  const existing = await db.players.countDocuments({ email: { $regex: DEMO_EMAIL } });
  if (existing > 0) fail("Demo players are already there (addresses ending in @demo.example).");

  const now = Date.now();
  const players: PlayerDoc[] = [];
  const runs: RunDoc[] = [];
  const bests: BestRunDoc[] = [];
  const consents: ConsentDoc[] = [];
  const events: EventDoc[] = [];

  // ---------- players, runs, consents ----------
  for (let i = 0; i < count; i++) {
    const lang = rand() < 0.68 ? "fr" : "en";
    const optIn = rand() < 0.42;
    const src = weighted();
    const at = new Date(now - rand() * DEMO_DAYS * DAY);
    const seed = int(1, 1_000_000);
    const activeMs = int(8_000, 75_000);
    const distanceM = distanceMAt(activeMs);
    const level = createLevel(seed);
    const garlic = Math.floor(rand() ** 1.5 * (level.garlicSpawnedUpTo(distanceM) + 1));
    const hits = int(0, Math.min(level.obstaclesSpawnedUpTo(distanceM), 6));
    const { points } = scoreOf({ distanceM, garlic });
    const playerId = randomUUID();
    const runId = randomUUID();
    const email = `player${String(i + 1).padStart(2, "0")}@demo.example`;
    const utm = { utm_source: src, utm_medium: "embed", utm_campaign: "shawarma-day" };

    players.push(
      newPlayer({
        _id: playerId,
        email,
        emailNormalized: email,
        nickname: autoNickname(rand),
        language: lang,
        ageConfirmedAt: at,
        marketingOptIn: optIn,
        firstSrc: src,
        firstHost: `https://${src}.example`,
        utm,
        createdAt: at,
        lastSeenAt: at,
      }),
    );
    runs.push(
      newRun({
        _id: runId,
        seed,
        playerId,
        src,
        hostOrigin: `https://${src}.example`,
        utm,
        language: lang,
        tuningVersion: TUNING.version,
        issuedAt: new Date(at.getTime() - activeMs - 2_000),
        finishedAt: at,
        activeMs,
        distanceM,
        garlic,
        hits,
        points,
        status: "valid",
        clientVersion: "demo",
        savedAt: at,
      }),
    );
    bests.push({ _id: playerId, runId, points, distanceM, garlic, achievedAt: at });

    const kinds: ConsentKind[] = optIn ? ["terms_age", "marketing"] : ["terms_age"];
    for (const kind of kinds) {
      const c = consentText(lang, kind);
      consents.push(
        newConsent({
          playerId,
          kind,
          granted: true,
          text: c.text,
          textVersion: c.version,
          language: lang,
          source: "save_form",
          ip: `203.0.113.${int(2, 250)}`,
          userAgent: "Mozilla/5.0 (demo)",
          hostOrigin: `https://${src}.example`,
          createdAt: at,
        }),
      );
    }
  }

  // ---------- flagged runs, for the moderation page ----------
  for (const flagReason of ["distance", "distance", "garlic", "too_fast", "hits", "version"]) {
    const at = new Date(now - rand() * 3 * DAY);
    runs.push(
      newRun({
        _id: randomUUID(),
        seed: int(1, 1_000_000),
        src: weighted(),
        tuningVersion: TUNING.version,
        issuedAt: new Date(at.getTime() - 22_000),
        finishedAt: at,
        activeMs: 20_000,
        distanceM: flagReason === "distance" ? 900 : 70,
        garlic: flagReason === "garlic" ? 60 : 3,
        hits: flagReason === "hits" ? 40 : 1,
        points: 0,
        status: "flagged",
        flagReason,
        clientVersion: "demo",
      }),
    );
  }

  // ---------- ten days of funnel events ----------
  for (let d = DEMO_DAYS - 1; d >= 0; d--) {
    // Traffic builds towards the launch.
    const loads = Math.round(60 + (DEMO_DAYS - d) * 35 + rand() * 40);
    for (let k = 0; k < loads; k++) {
      const src = weighted();
      const base = {
        sessionId: `demo-${d}-${k}`,
        src,
        lang: rand() < 0.68 ? "fr" : "en",
        device: pick(DEVICES),
        hostOrigin: `https://${src}.example`,
      };
      const at = new Date(now - d * DAY - rand() * DAY * 0.9);
      const ev = (name: ClientEvent, props: Record<string, string | number | boolean> = {}) =>
        events.push(newEvent({ ...base, name, props, createdAt: at }));
      ev("load");
      if (rand() > 0.34) continue;
      const plays = 1 + Math.floor(rand() * 3);
      for (let p = 0; p < plays; p++) {
        ev("start", { online: true });
        const reach = 20 + rand() ** 1.5 * 450;
        for (const points of MILESTONES.filter((m) => m <= reach)) ev("milestone", { points });
        ev("game_over", { points: Math.round(reach) });
      }
      ev("results_view");
      if (rand() < 0.3) ev("leaderboard_view");
      if (rand() < 0.1) ev("cta_click", { target: pick(["order", "locations"]) });
      if (rand() < 0.08) ev("share_click");
      if (rand() < 0.55) {
        ev("save_view");
        if (rand() < 0.7) {
          ev("save_submit");
          ev("save_success");
          // The server's own events carry no session.
          events.push(
            newEvent({
              name: "api_save",
              props: { outcome: "ok" },
              src,
              lang: base.lang,
              device: base.device,
              createdAt: at,
            }),
          );
          if (rand() < 0.42) {
            events.push(
              newEvent({
                name: "opt_in",
                src,
                lang: base.lang,
                device: base.device,
                createdAt: at,
              }),
            );
          }
        }
      }
    }
  }

  await db.players.insertMany(players);
  await db.runs.insertMany(runs);
  await db.bestRuns.insertMany(bests);
  await db.consents.insertMany(consents);
  for (let i = 0; i < events.length; i += 1000) {
    await db.events.insertMany(events.slice(i, i + 1000));
  }
  await rollupEvents(db, montrealDay(DEMO_DAYS));

  console.log(
    `Demo data added: ${count} players, 6 flagged runs, ${events.length} events (${DEMO_DAYS} days).`,
  );
  const top = await topEntries(db, WINNERS);
  console.log(`The top ${WINNERS} win:`);
  for (const e of top) console.log(`  ${e.rank}  ${e.name}  ${e.points} points`);
  console.log("Open /admin (sign in with an address in ADMIN_EMAILS) and the leaderboard.");
}

async function main() {
  loadLocalEnv();
  const open = process.argv.includes("--open");
  const demo = demoCount();
  if (demo > 0 && process.env.VERCEL_ENV === "production") {
    fail("Refusing to add demo players to production.");
  }
  const actor = `cli:${os.userInfo().username}`;
  const { db, client } = createDb(scriptDatabaseUrl(), { max: 1 });
  try {
    await db.campaignSettings.updateOne(
      { _id: 1 },
      { $setOnInsert: newCampaignSettings() },
      { upsert: true },
    );
    console.log("Contest settings: ready");
    if (open) await openContest(db, actor);
    if (demo > 0) await addDemoPlayers(db, demo);
  } finally {
    await client.close();
  }
}

main().catch(fail);
