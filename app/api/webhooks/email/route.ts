import { db } from "@/lib/server/db";
import { handleEmailEvent, verifyEmailWebhook } from "@/lib/server/email/webhook";
import { env } from "@/lib/server/env";
import { apiError, json, withErrors } from "@/lib/server/http";
import { log } from "@/lib/server/log";

/** POST /api/webhooks/email: bounces, complaints and suppressions from Resend (MAIL-07). */
export const POST = withErrors("email_webhook", async (request: Request) => {
  const secret = env().EMAIL_WEBHOOK_SECRET;
  if (!secret) {
    log.warn("email_webhook_not_configured");
    return apiError(503, "not_configured");
  }
  const raw = await request.text();
  if (raw.length > 64 * 1024) return apiError(413, "too_large");
  const event = verifyEmailWebhook(raw, request.headers, secret);
  if (!event) return apiError(401, "bad_signature");
  await handleEmailEvent(db(), event);
  return json({ ok: true });
});
