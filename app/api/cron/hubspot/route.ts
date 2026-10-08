import { db } from "@/lib/server/db";
import { apiError, isCronAuthorized, json, withErrors } from "@/lib/server/http";
import { deliverHubspotSignups } from "@/lib/server/hubspot";

export const maxDuration = 60;

export const GET = withErrors("cron_hubspot", async (request: Request) => {
  if (!isCronAuthorized(request)) return apiError(401, "unauthorized");
  return json({ ok: true, sent: await deliverHubspotSignups(db()) });
});
