import { runRetention } from "@/lib/server/admin/retention";
import { db } from "@/lib/server/db";
import { apiError, isCronAuthorized, json, withErrors } from "@/lib/server/http";

export const maxDuration = 60;

/**
 * Daily: once the contest has been over for the retention period, anonymizes players who did
 * not opt in and aren't winners (DATA-06), up to 500 a run, so a backlog clears over a few days.
 */
export const GET = withErrors("cron_retention", async (request: Request) => {
  if (!isCronAuthorized(request)) return apiError(401, "unauthorized");
  const result = await runRetention(db());
  return json({ ok: true, ...result });
});
