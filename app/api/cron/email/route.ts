import { db } from "@/lib/server/db";
import { deliverEmail, dueEmails, type DeliveryOutcome } from "@/lib/server/email/deliver";
import { apiError, isCronAuthorized, json, withErrors } from "@/lib/server/http";

export const maxDuration = 60;

/** Stop starting new sends this long into the run, to finish inside maxDuration. */
const BUDGET_MS = 45_000;

/** Every 5 minutes: sends due emails and retries failures for up to 24 h (MAIL-07). */
export const GET = withErrors("cron_email", async (request: Request) => {
  if (!isCronAuthorized(request)) return apiError(401, "unauthorized");
  const started = Date.now();
  const q = db();
  const counts: Partial<Record<DeliveryOutcome, number>> = {};
  for (const id of await dueEmails(q)) {
    if (Date.now() - started > BUDGET_MS) break;
    const outcome = await deliverEmail(q, id);
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return json({ ok: true, ...counts });
});
