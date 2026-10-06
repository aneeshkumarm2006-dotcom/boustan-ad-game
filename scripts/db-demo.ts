/**
 * Fills a dev or preview database with believable demo data, so the leaderboard and the admin
 * dashboard can be shown to a client: 60 players with scores, claims and codes, ten days of
 * funnel events, a few flagged runs and some redeemed codes. Every address ends in
 * @demo.example. Needs the seeded catalogue and a code pool (`npm run db:seed -- --open
 * --test-codes 200`). Refuses to run twice, and never on production.
 *
 *   npm run db:demo
 */
import { randomUUID } from "node:crypto";
import { createDb } from "../db/client";
import {
  newClaim,
  newConsent,
  newEmailOutbox,
  newEvent,
  newPlayer,
  newRun,
  type EventDoc,
} from "../db/schema";
import { TUNING } from "../game-core";
import { montrealDay, rollupEvents } from "../lib/server/analytics";
import { consentText, type ConsentKind } from "../lib/server/consent";
import { autoNickname } from "../lib/nicknames";
import { fail, loadLocalEnv, scriptDatabaseUrl } from "./local-env";

const DAY = 86_400_000;
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

async function main() {
  loadLocalEnv();
  if (process.env.VERCEL_ENV === "production") fail("Refusing to add demo data to production.");
  const { db, client } = createDb(scriptDatabaseUrl(), { max: 1 });
  try {
    const existing = await db.players.countDocuments({ email: { $regex: "@demo\\.example$" } });
    if (existing > 0) fail("Demo data is already there (players ending in @demo.example).");
    const pool = await db.rewards.find().toArray();
    if (pool.length === 0) fail("Run `npm run db:seed -- --open --test-codes 200` first.");

    const now = Date.now();
    const days = 10;

    // ---------- players, runs, claims ----------
    let claimsMade = 0;
    for (let i = 0; i < 60; i++) {
      const lang = rand() < 0.68 ? "fr" : "en";
      const optIn = rand() < 0.42;
      const src = weighted();
      const at = new Date(now - rand() * days * DAY);
      const garlic = Math.min(22, Math.floor(rand() ** 1.6 * 24));
      const hits = int(0, garlic > 8 ? 2 : 5);
      const distanceM = Math.round(50 + rand() * (garlic > 8 ? 380 : 170)) + rand();
      const playerId = randomUUID();
      const runId = randomUUID();
      const email = `player${String(i + 1).padStart(2, "0")}@demo.example`;
      const utm = { utm_source: src, utm_medium: "embed", utm_campaign: "shawarma-day" };

      await db.players.insertOne(
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
      await db.runs.insertOne(
        newRun({
          _id: runId,
          seed: int(1, 1_000_000),
          playerId,
          src,
          hostOrigin: `https://${src}.example`,
          utm,
          language: lang,
          rules: { distanceM: 100, garlic: 10 },
          tuningVersion: TUNING.version,
          issuedAt: new Date(at.getTime() - 60_000),
          finishedAt: at,
          activeMs: Math.round(distanceM * 280),
          distanceM,
          garlic,
          hits,
          status: "valid",
          clientVersion: "demo",
          claimedAt: at,
        }),
      );
      await db.bestRuns.insertOne({
        _id: playerId,
        runId,
        garlic,
        hits,
        distanceM,
        achievedAt: at,
      });

      const kinds: ConsentKind[] = optIn ? ["terms_age", "marketing"] : ["terms_age"];
      for (const kind of kinds) {
        const c = consentText(lang, kind, true);
        await db.consents.insertOne(
          newConsent({
            playerId,
            kind,
            granted: true,
            text: c.text,
            textVersion: c.version,
            language: lang,
            source: "claim_form",
            ip: `203.0.113.${int(2, 250)}`,
            userAgent: "Mozilla/5.0 (demo)",
            hostOrigin: `https://${src}.example`,
            createdAt: at,
          }),
        );
      }

      const earned = [
        ...(distanceM >= 100 ? (["free_coke"] as const) : []),
        ...(garlic >= 10 ? (["free_garlic_sauce"] as const) : []),
      ];
      const claimIds: string[] = [];
      for (const reward of earned) {
        const code = await db.codes.findOne(
          { rewardId: reward, status: "available" },
          { sort: { _id: 1 } },
        );
        if (!code) continue;
        const claimId = randomUUID();
        const redeemed = rand() < 0.35;
        await db.claims.insertOne(
          newClaim({
            _id: claimId,
            playerId,
            rewardId: reward,
            runId,
            codeId: code._id,
            expiresAt: new Date(at.getTime() + 30 * DAY),
            emailStatus: "sent",
            src,
            utm,
            language: lang,
            createdAt: at,
          }),
        );
        await db.codes.updateOne(
          { _id: code._id },
          {
            $set: {
              status: redeemed ? "redeemed" : "assigned",
              claimId,
              assignedAt: at,
              redeemedAt: redeemed ? new Date(at.getTime() + int(1, 6) * DAY) : null,
            },
          },
        );
        claimIds.push(claimId);
        claimsMade++;
      }
      if (claimIds.length > 0) {
        await db.emailOutbox.insertOne(
          newEmailOutbox({
            playerId,
            kind: "coupon",
            claimIds,
            language: lang,
            status: "sent",
            attempts: 1,
            createdAt: at,
            sentAt: at,
          }),
        );
      }
    }

    // ---------- flagged runs ----------
    const reasons = ["distance", "distance", "garlic", "too_fast", "hits", "version"];
    for (const flagReason of reasons) {
      const at = new Date(now - rand() * 3 * DAY);
      await db.runs.insertOne(
        newRun({
          _id: randomUUID(),
          seed: int(1, 1_000_000),
          src: weighted(),
          rules: { distanceM: 100, garlic: 10 },
          tuningVersion: TUNING.version,
          issuedAt: new Date(at.getTime() - 20_000),
          finishedAt: at,
          activeMs: 20_000,
          distanceM: flagReason === "distance" ? 900 : 70,
          garlic: flagReason === "garlic" ? 60 : 3,
          hits: flagReason === "hits" ? 40 : 1,
          status: "flagged",
          flagReason,
          clientVersion: "demo",
        }),
      );
    }

    // ---------- ten days of funnel events ----------
    const rows: EventDoc[] = [];
    for (let d = days - 1; d >= 0; d--) {
      // Traffic builds towards the launch.
      const loads = Math.round(60 + (days - d) * 35 + rand() * 40);
      for (let k = 0; k < loads; k++) {
        const src = weighted();
        const lang = rand() < 0.68 ? "fr" : "en";
        const device = pick(DEVICES);
        const session = `demo-${d}-${k}`;
        const at = new Date(now - d * DAY - rand() * DAY * 0.9);
        const base = {
          sessionId: session,
          src,
          lang,
          device,
          hostOrigin: `https://${src}.example`,
        };
        const ev = (name: string, props: Record<string, string | number | boolean> = {}) =>
          rows.push(newEvent({ ...base, name, props, createdAt: at }));
        ev("load");
        if (rand() > 0.34) continue;
        const plays = 1 + Math.floor(rand() * 3);
        for (let p = 0; p < plays; p++) ev("start", { online: true });
        if (rand() < 0.62) ev("milestone", { m: 100 });
        const garlic = rand() < 0.28;
        if (garlic) ev("reward_unlocked", { reward: "free_garlic_sauce" });
        if (rand() < 0.55) {
          ev("claim_view");
          if (rand() < 0.7) {
            ev("claim_success", { mode: "claim", codes: 1 + Number(garlic) });
            if (rand() < 0.42) ev("opt_in");
          }
        }
      }
    }
    for (let i = 0; i < rows.length; i += 1000) {
      await db.events.insertMany(rows.slice(i, i + 1000));
    }
    await rollupEvents(db, montrealDay(days));

    console.log(`Demo data added: 60 players, ${claimsMade} claims, ${rows.length} events.`);
    console.log("Open /admin (sign in with an address in ADMIN_EMAILS) and the leaderboard.");
  } finally {
    await client.close();
  }
}

main().catch(fail);
