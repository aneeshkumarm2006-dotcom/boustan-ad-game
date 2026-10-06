/**
 * Bounce and complaint events from Resend (MAIL-07). A hard bounce, a spam complaint or a
 * suppression blocks every future send to that player; a complaint also withdraws marketing
 * consent, logged like an unsubscribe (CASL). Soft bounces are left to Resend's own retries.
 */
import { Webhook } from "standardwebhooks";
import type { Db } from "@/db/client";
import { normalizeEmail } from "@/lib/email";
import { isLang } from "@/i18n";
import { recordServerEvent } from "../analytics";
import { recordConsent } from "../consent";
import { enqueueCrm } from "../crm-outbox";
import { log } from "../log";

export interface EmailEvent {
  type: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[];
    bounce?: { type?: string; subType?: string };
  };
}

/** Checks the Svix-style signature Resend puts on webhooks; returns the event or null. */
export function verifyEmailWebhook(
  raw: string,
  headers: Headers,
  secret: string,
): EmailEvent | null {
  try {
    return new Webhook(secret).verify(raw, {
      "webhook-id": headers.get("svix-id") ?? headers.get("webhook-id") ?? "",
      "webhook-timestamp": headers.get("svix-timestamp") ?? headers.get("webhook-timestamp") ?? "",
      "webhook-signature": headers.get("svix-signature") ?? headers.get("webhook-signature") ?? "",
    }) as EmailEvent;
  } catch {
    return null;
  }
}

type BlockKind = "bounced" | "complained" | "suppressed";

function blockKind(event: EmailEvent): BlockKind | null {
  if (event.type === "email.complained") return "complained";
  if (event.type === "email.suppressed") return "suppressed";
  if (event.type === "email.bounced") {
    // Resend reports "Permanent", "Transient" or "Undetermined"; only permanent ones block.
    return event.data?.bounce?.type?.toLowerCase() === "permanent" ? "bounced" : null;
  }
  return null;
}

export async function handleEmailEvent(q: Db, event: EmailEvent, now = new Date()): Promise<void> {
  const kind = blockKind(event);
  if (!kind) {
    log.info("email_event_ignored", { type: event.type, bounce: event.data?.bounce?.type });
    return;
  }

  // The provider id is the reliable link (the sandbox sends everything to one test address).
  let playerId: string | null = null;
  let emailId: string | null = null;
  if (event.data?.email_id) {
    const row = await q.emailOutbox.findOne(
      { providerId: event.data.email_id },
      { projection: { _id: 1, playerId: 1 } },
    );
    if (row) {
      playerId = row.playerId;
      emailId = row._id;
    }
  }
  const to = event.data?.to?.[0];
  if (!playerId && to) {
    const row = await q.players.findOne(
      { emailNormalized: normalizeEmail(to) },
      { projection: { _id: 1 } },
    );
    playerId = row?._id ?? null;
  }
  if (!playerId) {
    log.warn("email_event_unmatched", { type: event.type });
    return;
  }

  await q.transaction(async (tx) => {
    const player = await tx.players.findOne({ _id: playerId });
    if (!player) return;
    await tx.players.updateOne(
      { _id: player._id, emailBlockedAt: null },
      { $set: { emailBlockedAt: now, emailBlockReason: kind } },
    );
    if (emailId) {
      await tx.emailOutbox.updateOne({ _id: emailId }, { $set: { lastError: kind } });
    }
    if (kind === "complained" && player.marketingOptIn) {
      await recordConsent(tx, {
        playerId: player._id,
        kind: "marketing",
        granted: false,
        lang: isLang(player.language) ? player.language : "fr",
        source: "complaint",
        ip: null,
        userAgent: null,
        hostOrigin: null,
      });
      await tx.players.updateOne({ _id: player._id }, { $set: { marketingOptIn: false } });
      await enqueueCrm(
        tx,
        player._id,
        "consent_changed",
        { marketing: false, source: "complaint" },
        `consent:${player._id}:${now.getTime()}:complaint`,
      );
    }
  });
  await recordServerEvent(q, "email_bounced", { kind });
  log.info("email_blocked_by_provider", { kind, emailId });
}
