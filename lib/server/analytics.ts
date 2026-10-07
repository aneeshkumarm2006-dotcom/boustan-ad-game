/**
 * First-party analytics storage (AN-01, AN-02) and the daily rollup behind the funnel view.
 * Nothing personal is stored: event names, a few small props, placement, language, device class.
 */
import type { Document } from "mongodb";
import type { Queryable } from "@/db/client";
import { newEvent } from "@/db/schema";
import type { EventProps, ServerEvent } from "@/lib/analytics-events";
import { parseMontrealLocal } from "./admin/time";

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
  await q.events.insertOne(
    newEvent({
      name,
      props,
      src: ctx.src ?? null,
      lang: ctx.lang ?? null,
      device: ctx.device ?? null,
      hostOrigin: ctx.hostOrigin ?? null,
    }),
  );
}

/** Montréal calendar date `daysAgo` days before now, as YYYY-MM-DD. */
export function montrealDay(daysAgo = 0, now = Date.now()): string {
  const d = new Date(now - daysAgo * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(d);
}

/** The instant a Montréal calendar day (YYYY-MM-DD) begins. */
export function montrealDayStart(day: string): Date {
  const start = parseMontrealLocal(day);
  if (!start) throw new Error(`Not a calendar day: ${day}`);
  return start;
}

/** The one prop that splits each event in the rollup (`events_daily.detail`). */
const DETAIL_PROP: Record<string, string> = {
  milestone: "points",
  cta_click: "target",
  save_error: "reason",
  api_save: "outcome",
};

const ROLLUP_CHUNK = 1000;

/**
 * Recounts events_daily for every Montréal day from `fromDay` on. Idempotent, so a cron that
 * runs twice or late does no harm (Vercel Cron is best effort).
 */
export async function rollupEvents(q: Queryable, fromDay: string): Promise<number> {
  const detail: Document = {
    $switch: {
      branches: Object.entries(DETAIL_PROP).map(([name, prop]) => ({
        case: { $eq: ["$name", name] },
        // A prop can be a number or a boolean; the rollup keeps its text, as "100" or "true".
        then: { $ifNull: [{ $toString: `$props.${prop}` }, ""] },
      })),
      default: "",
    },
  };
  const rows = await q.events
    .aggregate<{
      _id: { day: string; name: string; detail: string; src: string; lang: string; device: string };
      events: number;
      sessions: number;
    }>(
      [
        { $match: { createdAt: { $gte: montrealDayStart(fromDay) } } },
        // First one group per session, so each session counts once however many events it sent.
        {
          $group: {
            _id: {
              day: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$createdAt",
                  timezone: "America/Toronto",
                },
              },
              name: "$name",
              detail,
              src: { $ifNull: ["$src", ""] },
              lang: { $ifNull: ["$lang", ""] },
              device: { $ifNull: ["$device", ""] },
              session: { $ifNull: ["$sessionId", null] },
            },
            n: { $sum: 1 },
          },
        },
        {
          $group: {
            _id: {
              day: "$_id.day",
              name: "$_id.name",
              detail: "$_id.detail",
              src: "$_id.src",
              lang: "$_id.lang",
              device: "$_id.device",
            },
            events: { $sum: "$n" },
            // Server events have no session and add to the event count only.
            sessions: { $sum: { $cond: [{ $eq: ["$_id.session", null] }, 0, 1] } },
          },
        },
      ],
      { allowDiskUse: true },
    )
    .toArray();

  for (let i = 0; i < rows.length; i += ROLLUP_CHUNK) {
    await q.eventsDaily.bulkWrite(
      rows.slice(i, i + ROLLUP_CHUNK).map((r) => ({
        updateOne: {
          filter: r._id,
          update: { $set: { events: r.events, sessions: r.sessions } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }
  return rows.length;
}
