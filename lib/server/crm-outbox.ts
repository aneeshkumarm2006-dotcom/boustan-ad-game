/**
 * CRM outbox (CRM-05). Rows are written in the same transaction as the claim or consent change
 * they describe, so the CRM never misses one and a CRM outage never fails a claim. Delivery,
 * retries and the adapters (`none`, `webhook`, `hubspot`) come in Stage 3; payloads hold ids
 * and facts, and the adapter reads the current contact when it delivers.
 */
import type { Queryable } from "@/db/client";
import { crmOutbox } from "@/db/schema";

export type CrmEventType = "contact_upsert" | "reward_claimed" | "consent_changed";

export async function enqueueCrm(
  q: Queryable,
  playerId: string,
  type: CrmEventType,
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Promise<void> {
  await q
    .insert(crmOutbox)
    .values({ playerId, type, payload, idempotencyKey })
    .onConflictDoNothing({ target: crmOutbox.idempotencyKey });
}
