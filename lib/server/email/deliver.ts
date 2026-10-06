/**
 * Coupon email delivery (MAIL-02, MAIL-07). The claim queues a row in email_outbox inside its
 * transaction; `after()` sends it once the response is out, and /api/cron/email retries
 * failures with growing delays for up to 24 hours. A short lease on the row means the cron and
 * `after()` can never send the same email twice, and Resend's idempotency key covers a crash
 * between sending and recording it.
 */
import { and, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { Db, Queryable } from "@/db/client";
import { claims, codes, emailOutbox, players } from "@/db/schema";
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

export async function deliverEmail(
  q: Db,
  emailId: string,
  send: Sender = defaultSender,
  now = new Date(),
): Promise<DeliveryOutcome> {
  const [row] = await q
    .update(emailOutbox)
    .set({
      status: "sending",
      leaseUntil: new Date(now.getTime() + LEASE_MS),
      attempts: sql`${emailOutbox.attempts} + 1`,
    })
    .where(
      and(
        eq(emailOutbox.id, emailId),
        or(
          // New rows go at once: their next_attempt_at is the database clock, not ours.
          eq(emailOutbox.status, "pending"),
          and(eq(emailOutbox.status, "retry"), lte(emailOutbox.nextAttemptAt, now)),
          and(eq(emailOutbox.status, "sending"), lt(emailOutbox.leaseUntil, now)),
        ),
      ),
    )
    .returning();
  if (!row) return "skipped";

  const coupon = row.kind === "coupon";
  const finish = async (
    status: "sent" | "retry" | "failed" | "blocked",
    extra: Partial<typeof emailOutbox.$inferInsert> = {},
  ) => {
    await q
      .update(emailOutbox)
      .set({ status, leaseUntil: null, ...extra })
      .where(eq(emailOutbox.id, row.id));
    // A failed re-send doesn't change how the original went.
    if (status !== "retry" && (coupon || status === "sent")) {
      await q.update(claims).set({ emailStatus: status }).where(inArray(claims.id, row.claimIds));
    }
  };

  const [player] = await q.select().from(players).where(eq(players.id, row.playerId));
  if (!player || player.deletedAt || player.emailBlockedAt) {
    await finish("blocked", { lastError: player?.emailBlockReason ?? "player gone" });
    log.info("email_blocked", { emailId: row.id });
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
      emailId: row.id,
      playerId: player.id,
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
      idempotencyKey: `email-${row.id}`,
      tags: [{ name: "kind", value: row.kind }],
    });
    await finish("sent", { providerId: id, sentAt: new Date(), lastError: null });
    await recordServerEvent(q, "email_sent", { kind: row.kind }, { lang });
    log.info("email_sent", { emailId: row.id, kind: row.kind, attempt: row.attempts });
    return "sent";
  } catch (error) {
    const retryable = error instanceof SendError ? error.retryable : true;
    const delay = retryDelayMs(row.attempts);
    const message = scrub(error instanceof Error ? error.message : String(error));
    if (retryable && now.getTime() - row.createdAt.getTime() + delay < GIVE_UP_MS) {
      await finish("retry", { nextAttemptAt: new Date(now.getTime() + delay), lastError: message });
      log.warn("email_retry", { emailId: row.id, attempt: row.attempts, error: message });
      return "retry";
    }
    await finish("failed", { lastError: message });
    await log.error("email_failed", error, { emailId: row.id, attempt: row.attempts });
    return "failed";
  }
}

/** The codes an email holds, in catalogue order, and the placement they were claimed from. */
export async function loadCouponLines(
  q: Queryable,
  email: { claimIds: string[]; playerId: string },
): Promise<{ lines: CouponEmailData["codes"]; src: string | null }> {
  const rows = await q
    .select({
      reward: claims.rewardId,
      code: codes.code,
      expiresAt: claims.expiresAt,
      src: claims.src,
    })
    .from(claims)
    .innerJoin(codes, eq(codes.id, claims.codeId))
    .where(and(inArray(claims.id, email.claimIds), eq(claims.playerId, email.playerId)));
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
  const rows = await q
    .select({ id: emailOutbox.id })
    .from(emailOutbox)
    .where(
      or(
        eq(emailOutbox.status, "pending"),
        and(eq(emailOutbox.status, "retry"), lte(emailOutbox.nextAttemptAt, now)),
        and(eq(emailOutbox.status, "sending"), lt(emailOutbox.leaseUntil, now)),
      ),
    )
    .orderBy(emailOutbox.nextAttemptAt)
    .limit(limit);
  return rows.map((r) => r.id);
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
    await q
      .update(emailOutbox)
      .set({
        claimIds: sql`${emailOutbox.claimIds} || array[${sql.join(
          claimIds.map((id) => sql`${id}`),
          sql`, `,
        )}]::uuid[]`,
      })
      .where(and(eq(emailOutbox.id, addTo), eq(emailOutbox.status, "pending")));
    return addTo;
  }
  const [row] = await q
    .insert(emailOutbox)
    .values({ playerId, kind: "resend", claimIds, language: lang })
    .returning({ id: emailOutbox.id });
  return row.id;
}
