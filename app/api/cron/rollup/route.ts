import { montrealDay, rollupEvents } from "@/lib/server/analytics";
import { db } from "@/lib/server/db";
import { apiError, isCronAuthorized, json, withErrors } from "@/lib/server/http";

export const maxDuration = 60;

/**
 * Daily, plus hourly for a fresh "today": recounts the last 3 days into events_daily, which
 * the funnel view reads (AN-02, ADM-02). Recounting makes a missed or repeated run harmless.
 */
export const GET = withErrors("cron_rollup", async (request: Request) => {
  if (!isCronAuthorized(request)) return apiError(401, "unauthorized");
  const rows = await rollupEvents(db(), montrealDay(2));
  return json({ ok: true, rows });
});
