/**
 * Coupon email delivery (MAIL-02, MAIL-07). The claim queues a row in email_outbox inside its
 * transaction; `after()` sends it once the response is out, and /api/cron/email retries
 * failures with growing delays for up to 24 hours. A short lease on the row means the cron and
 * `after()` can never send the same email twice, and Resend's idempotency key covers a crash
 * between sending and recording it.
 */
import type { Db, Queryable } from "@/db/client";
import { newEmailOutbox, type EmailOutboxDoc } from "@/db/schema";
import { REWARD_IDS, isRewardId, type RewardId } from "@/game-core";
import { isLang } from "@/i18n";
import { recordServerEvent } from "../analytics";
import { log } from "../log";
import { scrub } from "../scrub";
import { renderCouponEmail, type CouponEmailData } from "./render";
import { defaultSender, SendError, type Sender } from "./sender";

/** Minutes to wait after each failed attempt. */
const BACKOFF_MIN = [1, 5, 15, 60, 180, 360, 720];
const GIVE_UP_MS = 24 * 60 * 60 * 1000;
const LEASE_MS = 2 * 60 * 1000;

export type DeliveryOutcome = "sent" | "retry" | "failed" | "blocked" | "skipped";

export function retryDelayMs(attempt: number): number {
  return BACKOFF_MIN[Math.min(Math.max(attempt, 1), BACKOFF_MIN.length) - 1] * 60_000;
}

/** Emails that can be picked up now: new, waiting for a retry, or held by a sender that died. */
const dueFilter = (now: Date) => ({
  $or: [
    // New rows go at once, whatever their nextAttemptAt says.
    { status: "pending" },
    { status: "retry", nextAttemptAt: { $lte: now } },
    { status: "sending", leaseUntil: { $lt: now } },
  ],
});

export async function deliverEmail(
  q: Db,
  emailId: string,
  send: Sender = defaultSender,
  now = new Date(),
): Promise<DeliveryOutcome> {
  // One atomic update takes the lease, so two senders can't both get the row.
  const row = await q.emailOutbox.findOneAndUpdate(
    { _id: emailId, ...dueFilter(now) },
    {
      $set: { status: "sending", leaseUntil: new Date(now.getTime() + LEASE_MS) },
      $inc: { attempts: 1 },
    },
    { returnDocument: "after" },
  );
  if (!row) return "skipped";

  const coupon = row.kind === "coupon";
  const finish = async (
    status: "sent" | "retry" | "failed" | "blocked",
    extra: Partial<EmailOutboxDoc> = {},
  ) => {
    await q.emailOutbox.updateOne(
      { _id: row._id },
      { $set: { status, leaseUntil: null, ...extra } },
    );
    // A failed re-send doesn't change how the original went.
    if (status !== "retry" && (coupon || status === "sent")) {
      await q.claims.updateMany({ _id: { $in: row.claimIds } }, { $set: { emailStatus: status } });
    }
  };

  const player = await q.players.findOne({ _id: row.playerId });
  if (!player || player.deletedAt || player.emailBlockedAt) {
    await finish("blocked", { lastError: player?.emailBlockReason ?? "player gone" });
    log.info("email_blocked", { emailId: row._id });
    return "blocked";
  }

  const { lines, src } = await loadCouponLines(q, row);
  if (lines.length === 0) {
    await finish("failed", { lastError: "no codes" });
    return "failed";
  }

  try {
    const lang = isLang(row.language) ? row.language : "fr";
    const email = await renderCouponEmail({
      emailId: row._id,
      playerId: player._id,
      lang,
      resend: !coupon,
      src,
      codes: lines,
    });
    const { id } = await send({
      to: player.email,
      subject: email.subject,
      html: email.html,
      text: email.text,
      headers: {
        "List-Unsubscribe": `<${email.unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      idempotencyKey: `email-${row._id}`,
      tags: [{ name: "kind", value: row.kind }],
    });
    await finish("sent", { providerId: id, sentAt: new Date(), lastError: null });
    await recordServerEvent(q, "email_sent", { kind: row.kind }, { lang });
    log.info("email_sent", { emailId: row._id, kind: row.kind, attempt: row.attempts });
    return "sent";
  } catch (error) {
    const retryable = error instanceof SendError ? error.retryable : true;
    const delay = retryDelayMs(row.attempts);
    const message = scrub(error instanceof Error ? error.message : String(error));
    if (retryable && now.getTime() - row.createdAt.getTime() + delay < GIVE_UP_MS) {
      await finish("retry", { nextAttemptAt: new Date(now.getTime() + delay), lastError: message });
      log.warn("email_retry", { emailId: row._id, attempt: row.attempts, error: message });
      return "retry";
    }
    await finish("failed", { lastError: message });
    await log.error("email_failed", error, { emailId: row._id, attempt: row.attempts });
    return "failed";
  }
}

/** The codes an email holds, in catalogue order, and the placement they were claimed from. */
export async function loadCouponLines(
  q: Queryable,
  email: { claimIds: string[]; playerId: string },
): Promise<{ lines: CouponEmailData["codes"]; src: string | null }> {
  const claims = await q.claims
    .find({ _id: { $in: email.claimIds }, playerId: email.playerId, codeId: { $ne: null } })
    .sort({ createdAt: 1, _id: 1 })
    .toArray();
  const held = await q.codes.find({ _id: { $in: claims.map((c) => c.codeId!) } }).toArray();
  const codeOf = new Map(held.map((c) => [c._id.toHexString(), c.code]));
  const rows = claims
    .filter((c) => codeOf.has(c.codeId!.toHexString()))
    .map((c) => ({
      reward: c.rewardId,
      code: codeOf.get(c.codeId!.toHexString())!,
      expiresAt: c.expiresAt,
      src: c.src,
    }));
  const lines = rows
    .filter((r): r is typeof r & { reward: RewardId } => isRewardId(r.reward))
    .sort((a, b) => REWARD_IDS.indexOf(a.reward) - REWARD_IDS.indexOf(b.reward))
    .map((r) => ({
      reward: r.reward,
      code: r.code,
      // Claims always get an expiry; the fallback only guards old rows.
      expiresAt: (r.expiresAt ?? new Date()).toISOString(),
    }));
  return { lines, src: rows[0]?.src ?? null };
}

/** Emails due now: new, waiting for a retry, or held by a sender that died. */
export async function dueEmails(q: Db, now = new Date(), limit = 50): Promise<string[]> {
  const rows = await q.emailOutbox
    .find(dueFilter(now), { projection: { _id: 1 } })
    .sort({ nextAttemptAt: 1 })
    .limit(limit)
    .toArray();
  return rows.map((r) => r._id);
}

/** Queues a re-send of earlier codes (MAIL-08), or adds them to an email already queued. */
export async function queueResend(
  q: Db,
  playerId: string,
  claimIds: string[],
  lang: string,
  addTo: string | null,
): Promise<string | null> {
  if (claimIds.length === 0) return addTo;
  if (addTo) {
    await q.emailOutbox.updateOne(
      { _id: addTo, status: "pending" },
      { $push: { claimIds: { $each: claimIds } } },
    );
    return addTo;
  }
  const email = newEmailOutbox({ playerId, kind: "resend", claimIds, language: lang });
  await q.emailOutbox.insertOne(email);
  return email._id;
}
