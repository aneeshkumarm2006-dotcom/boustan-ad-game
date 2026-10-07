import { checkAlerts } from "@/lib/server/alerts";
import { db } from "@/lib/server/db";
import { apiError, isCronAuthorized, json, withErrors } from "@/lib/server/http";

/** Every 15 minutes: the "Save my score" error rate → Sentry (NFR-08). */
export const GET = withErrors("cron_alerts", async (request: Request) => {
  if (!isCronAuthorized(request)) return apiError(401, "unauthorized");
  return json({ ok: true, alerts: await checkAlerts(db()) });
});
