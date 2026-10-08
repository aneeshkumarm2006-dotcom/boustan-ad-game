import "server-only";
import type { Db } from "@/db/client";
import { env } from "./env";
import { log } from "./log";

/** Deliver only new signup events, leaving historical CRM and consent events untouched. */
export async function deliverHubspotSignups(q: Db, playerId?: string): Promise<number> {
  const url = env().HUBSPOT_SIGNUP_WEBHOOK_URL;
  if (!url) return 0;
  const deadline = Date.now() + 40_000;
  let sent = 0;
  for (let count = 0; count < 20 && Date.now() < deadline; count++) {
    // A recoverable lease prevents simultaneous signup/cron workers claiming the same row.
    const row = await q.crmOutbox.findOneAndUpdate(
      {
        type: "contact_upsert",
        "payload.signupWebhook": true,
        status: "pending",
        nextAttemptAt: { $lte: new Date() },
        ...(playerId ? { playerId } : {}),
      },
      { $set: { nextAttemptAt: new Date(Date.now() + 120_000) }, $inc: { attempts: 1 } },
      { sort: { nextAttemptAt: 1 }, returnDocument: "after" },
    );
    if (!row) break;
    const player = await q.players.findOne({ _id: row.playerId, deletedAt: null });
    if (!player) {
      await q.crmOutbox.updateOne({ _id: row._id }, { $set: { status: "skipped" } });
      continue;
    }
    let error: string | null = null;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": row.idempotencyKey },
        body: JSON.stringify({
          email: player.emailNormalized,
          name: player.nickname ?? "",
          marketingOptIn: player.marketingOptIn,
          eventId: row.idempotencyKey,
        }),
        signal: AbortSignal.timeout(8_000),
        redirect: "error",
      });
      if (!response.ok) error = `http_${response.status}`;
      await response.body?.cancel();
    } catch {
      // Never persist/log response bodies or errors that could contain contact data or the URL.
      error = "network_error";
    }
    if (error) {
      await q.crmOutbox.updateOne(
        { _id: row._id },
        {
          $set: {
            lastError: error,
            nextAttemptAt: new Date(
              Date.now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(row.attempts - 1, 6)),
            ),
          },
        },
      );
      log.warn("hubspot_signup_retry", { reason: error, attempts: row.attempts });
    } else {
      const now = new Date();
      await q.crmOutbox.updateOne(
        { _id: row._id },
        { $set: { status: "sent", sentAt: now, lastError: null } },
      );
      await q.players.updateOne(
        { _id: player._id, deletedAt: null },
        { $set: { crmStatus: "synced", crmSyncedAt: now } },
      );
      sent++;
    }
  }
  return sent;
}
