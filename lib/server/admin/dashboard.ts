/**
 * Dashboard data (ADM-02): the daily funnel from v_funnel_daily, split by placement, language
 * or device, plus health numbers. The funnel reads the rollup table, which the dashboard
 * refreshes (at most once a minute) so today's numbers are current even between cron runs.
 */
import { sql } from "drizzle-orm";
import type { Db, Queryable } from "@/db/client";
import { montrealDay, rollupEvents } from "../analytics";

export const FUNNEL_STEPS = [
  { key: "loads", label: "Game loads" },
  { key: "starts", label: "Runs started" },
  { key: "reached100m", label: "Reached 100 m" },
  { key: "garlic10", label: "Got 10 garlic" },
  { key: "claimViews", label: "Opened the claim form" },
  { key: "claims", label: "Claimed" },
  { key: "optIns", label: "Opted in" },
] as const;

export type FunnelKey = (typeof FUNNEL_STEPS)[number]["key"];
export type Funnel = Record<FunnelKey, number>;
export type Split = "day" | "src" | "lang" | "device";
export const SPLITS: Split[] = ["day", "src", "lang", "device"];

export const emptyFunnel = (): Funnel => ({
  loads: 0,
  starts: 0,
  reached100m: 0,
  garlic10: 0,
  claimViews: 0,
  claims: 0,
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

const COLUMN: Record<Split, ReturnType<typeof sql.raw>> = {
  day: sql.raw("day::text"),
  src: sql.raw("src"),
  lang: sql.raw("lang"),
  device: sql.raw("device"),
};

/** Funnel rows between two Montréal days (inclusive), grouped by `split`. */
export async function funnel(
  q: Queryable,
  from: string,
  to: string,
  split: Split,
): Promise<FunnelRow[]> {
  const col = COLUMN[split];
  const rows = await q.execute<Record<string, string | number> & { key: string }>(sql`
    select ${col} as key,
      sum(loads)::int as "loads", sum(starts)::int as "starts",
      sum(reached_100m)::int as "reached100m", sum(garlic_10)::int as "garlic10",
      sum(claim_views)::int as "claimViews", sum(claims)::int as "claims",
      sum(opt_ins)::int as "optIns"
    from v_funnel_daily
    where day between ${from}::date and ${to}::date
    group by 1
    order by ${split === "day" ? sql`1 desc` : sql`"starts" desc, 1`}
  `);
  return rows.map((r) => ({
    key: String(r.key ?? ""),
    loads: Number(r.loads),
    starts: Number(r.starts),
    reached100m: Number(r.reached100m),
    garlic10: Number(r.garlic10),
    claimViews: Number(r.claimViews),
    claims: Number(r.claims),
    optIns: Number(r.optIns),
  }));
}

export function sumFunnel(rows: Funnel[]): Funnel {
  const total = emptyFunnel();
  for (const r of rows) for (const { key } of FUNNEL_STEPS) total[key] += r[key];
  return total;
}

export interface Health {
  players: number;
  optedIn: number;
  claimsToday: number;
  emailsFailed: number;
  emailsWaiting: number;
  flaggedRuns24h: number;
  runs24h: number;
}

export async function health(q: Queryable): Promise<Health> {
  const [row] = await q.execute<Record<string, number>>(sql`
    select
      (select count(*)::int from players where deleted_at is null) as players,
      (select count(*)::int from players where deleted_at is null and marketing_opt_in) as opted_in,
      (select count(*)::int from claims
        where (created_at at time zone 'America/Toronto')::date
            = (now() at time zone 'America/Toronto')::date) as claims_today,
      (select count(*)::int from email_outbox where status = 'failed') as emails_failed,
      (select count(*)::int from email_outbox where status in ('pending', 'retry', 'sending')) as emails_waiting,
      (select count(*)::int from runs where status = 'flagged' and finished_at > now() - interval '24 hours') as flagged,
      (select count(*)::int from runs where finished_at > now() - interval '24 hours') as runs
  `);
  return {
    players: Number(row.players),
    optedIn: Number(row.opted_in),
    claimsToday: Number(row.claims_today),
    emailsFailed: Number(row.emails_failed),
    emailsWaiting: Number(row.emails_waiting),
    flaggedRuns24h: Number(row.flagged),
    runs24h: Number(row.runs),
  };
}

/** The last `n` audit rows, newest first. */
export async function recentAudit(q: Queryable, limit = 100, offset = 0) {
  return q.execute<{
    id: number;
    admin_email: string;
    action: string;
    target: string | null;
    details: Record<string, unknown>;
    created_at: Date | string;
  }>(sql`
    select id, admin_email, action, target, details, created_at
    from admin_audit order by id desc limit ${limit} offset ${offset}
  `);
}
