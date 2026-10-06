import { runStockAlerts } from "@/lib/server/admin/stock-alerts";
import { db } from "@/lib/server/db";
import { apiError, isCronAuthorized, json, withErrors } from "@/lib/server/http";

export const maxDuration = 60;

/** Hourly: emails the alert recipients when a code pool falls to a threshold (RWD-04). */
export const GET = withErrors("cron_stock", async (request: Request) => {
  if (!isCronAuthorized(request)) return apiError(401, "unauthorized");
  const results = await runStockAlerts(db());
  return json({ ok: true, pools: results });
});
