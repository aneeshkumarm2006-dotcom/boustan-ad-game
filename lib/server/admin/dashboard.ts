/**
 * Dashboard data (ADM-02): the daily funnel read from the events_daily rollup, split by
 * placement, language or device, plus health numbers. The dashboard refreshes the rollup (at
 * most once a minute) so today's numbers are current even between cron runs.
 */
import type { Document } from "mongodb";
import type { Db, Queryable } from "@/db/client";
import { montrealDay, montrealDayStart, rollupEvents } from "../analytics";
import { SAVE_WINDOW_MS } from "../runs";
import { topBestRuns } from "./moderation";

export const FUNNEL_STEPS = [
  { key: "loads", label: "Game loads" },
  { key: "starts", label: "Runs started" },
  { key: "finishes", label: "Runs finished" },
  { key: "saveViews", label: "Opened the save form" },
  { key: "saves", label: "Saved a score" },
  { key: "optIns", label: "Opted in" },
] as const;

export type FunnelKey = (typeof FUNNEL_STEPS)[number]["key"];
export type Funnel = Record<FunnelKey, number>;
export type Split = "day" | "src" | "lang" | "device";
export const SPLITS: Split[] = ["day", "src", "lang", "device"];

export const emptyFunnel = (): Funnel => ({
  loads: 0,
  starts: 0,
  finishes: 0,
  saveViews: 0,
  saves: 0,
  optIns: 0,
});

let lastRollup = 0;

/** Recounts the last two days unless that was done in the past minute. */
export async function refreshRollup(q: Db, now = Date.now()): Promise<void> {
  if (now - lastRollup < 60_000) return;
  lastRollup = now;
  await rollupEvents(q, montrealDay(1, now));
}

export function resetRollupClockForTests(): void {
  lastRollup = 0;
}

export interface FunnelRow extends Funnel {
  /** The day (YYYY-MM-DD) or the placement, language or device; blank is "(none)". */
  key: string;
}

/** `$sum` of `field` over the rollup rows for one event. */
const sumOf = (field: "events" | "sessions", name: string): Document => ({
  $sum: { $cond: [{ $eq: ["$name", name] }, `$${field}`, 0] },
});

/** Funnel rows between two Montréal days (inclusive), grouped by `split`. */
export async function funnel(
  q: Queryable,
  from: string,
  to: string,
  split: Split,
): Promise<FunnelRow[]> {
  const rows = await q.eventsDaily
    .aggregate<{ _id: string | null } & Funnel>([
      { $match: { day: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: `$${split}`,
          // Loads are distinct sessions; every other step counts events.
          loads: sumOf("sessions", "load"),
          starts: sumOf("events", "start"),
          finishes: sumOf("events", "game_over"),
          saveViews: sumOf("events", "save_view"),
          saves: sumOf("events", "save_success"),
          optIns: sumOf("events", "opt_in"),
        },
      },
      // Newest day first; otherwise the busiest placement, language or device first.
      { $sort: split === "day" ? { _id: -1 } : { starts: -1, _id: 1 } },
    ])
    .toArray();
  return rows.map((r) => ({
    key: String(r._id ?? ""),
    loads: r.loads,
    starts: r.starts,
    finishes: r.finishes,
    saveViews: r.saveViews,
    saves: r.saves,
    optIns: r.optIns,
  }));
}

export function sumFunnel(rows: Funnel[]): Funnel {
  const total = emptyFunnel();
  for (const r of rows) for (const { key } of FUNNEL_STEPS) total[key] += r[key];
  return total;
}

export interface Health {
  /** Players with an email, so on the leaderboard (hidden ones included). */
  players: number;
  optedIn: number;
  runs24h: number;
  flaggedRuns24h: number;
  /** Runs credited to a player since Montréal midnight. */
  savedToday: number;
  /** The leader's score, or null while the board is empty. */
  top: { points: number; nickname: string | null } | null;
}

export async function health(q: Queryable, now = new Date()): Promise<Health> {
  const day = new Date(now.getTime() - 24 * 3_600_000);
  const today = montrealDayStart(montrealDay(0, now.getTime()));
  // One query after another keeps this usable inside a transaction too.
  const [leader] = await topBestRuns(q, 1);
  const owner = leader
    ? await q.players.findOne({ _id: leader._id }, { projection: { nickname: 1 } })
    : null;
  return {
    players: await q.players.countDocuments({ deletedAt: null }),
    optedIn: await q.players.countDocuments({ deletedAt: null, marketingOptIn: true }),
    runs24h: await q.runs.countDocuments({ finishedAt: { $gt: day } }),
    flaggedRuns24h: await q.runs.countDocuments({ status: "flagged", finishedAt: { $gt: day } }),
    // A run is saved at most SAVE_WINDOW_MS after it finished, so the finish-time bound only
    // lets the runs_finished index narrow the search.
    savedToday: await q.runs.countDocuments({
      finishedAt: { $gte: new Date(today.getTime() - SAVE_WINDOW_MS) },
      savedAt: { $gte: today },
    }),
    top: leader ? { points: leader.points, nickname: owner?.nickname ?? null } : null,
  };
}

export interface AuditRow {
  id: string;
  adminEmail: string;
  action: string;
  target: string | null;
  details: Record<string, unknown>;
  createdAt: Date;
}

/** Audit rows, newest first. */
export async function recentAudit(q: Queryable, limit = 100, offset = 0): Promise<AuditRow[]> {
  const rows = await q.adminAudit.find().sort({ _id: -1 }).skip(offset).limit(limit).toArray();
  return rows.map((r) => ({
    id: r._id.toHexString(),
    adminEmail: r.adminEmail,
    action: r.action,
    target: r.target,
    details: r.details,
    createdAt: r.createdAt,
  }));
}
