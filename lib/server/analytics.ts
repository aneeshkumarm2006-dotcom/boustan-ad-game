/**
 * First-party analytics storage (AN-01, AN-02) and the daily rollup behind the funnel view.
 * Nothing personal is stored: event names, a few small props, placement, language, device class.
 */
import { sql } from "drizzle-orm";
import type { Queryable } from "@/db/client";
import { events } from "@/db/schema";
import type { EventProps, ServerEvent } from "@/lib/analytics-events";

export type Device = "mobile" | "tablet" | "desktop";

/** Coarse device class from the user agent, for the funnel split (ADM-02). */
export function deviceOf(userAgent: string | null): Device | null {
  if (!userAgent) return null;
  if (/iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(userAgent)) return "tablet";
  if (/Mobi|iPhone|iPod|Android|BlackBerry|IEMobile|Opera Mini/i.test(userAgent)) return "mobile";
  return "desktop";
}

export interface EventContext {
  src?: string | null;
  lang?: string | null;
  device?: Device | null;
  hostOrigin?: string | null;
}

export async function recordServerEvent(
  q: Queryable,
  name: ServerEvent,
  props: EventProps = {},
  ctx: EventContext = {},
): Promise<void> {
  await q.insert(events).values({
    name,
    props,
    src: ctx.src ?? null,
    lang: ctx.lang ?? null,
    device: ctx.device ?? null,
    hostOrigin: ctx.hostOrigin ?? null,
  });
}

/** Montréal calendar date `daysAgo` days before now, as YYYY-MM-DD. */
export function montrealDay(daysAgo = 0, now = Date.now()): string {
  const d = new Date(now - daysAgo * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(d);
}

/**
 * Recounts events_daily for every Montréal day from `fromDay` on. Idempotent, so a cron that
 * runs twice or late does no harm (Vercel Cron is best effort).
 */
export async function rollupEvents(q: Queryable, fromDay: string): Promise<number> {
  const rows = await q.execute(sql`
    insert into events_daily (day, name, detail, src, lang, device, events, sessions)
    select
      (created_at at time zone 'America/Toronto')::date as day,
      name,
      coalesce(case name
        when 'milestone' then props->>'m'
        when 'reward_unlocked' then props->>'reward'
        when 'cta_click' then props->>'target'
        when 'claim_error' then props->>'reason'
        when 'email_bounced' then props->>'kind'
        when 'api_claim' then props->>'outcome'
        else '' end, '') as detail,
      coalesce(src, ''), coalesce(lang, ''), coalesce(device, ''),
      count(*)::int,
      count(distinct session_id)::int
    from events
    where created_at >= (${fromDay}::date::timestamp at time zone 'America/Toronto')
    group by 1, 2, 3, 4, 5, 6
    on conflict (day, name, detail, src, lang, device)
    do update set events = excluded.events, sessions = excluded.sessions
    returning 1
  `);
  return rows.length;
}
