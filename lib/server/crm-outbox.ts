/**
 * CRM outbox (CRM-05). Rows are written in the same transaction as the save or consent change
 * they describe, so the CRM never misses one and a CRM outage never fails a save. Delivery,
 * retries and the adapters (`none`, `webhook`, `hubspot`) come in Stage 3; payloads hold ids
 * and facts, and the adapter reads the current contact when it delivers.
 */
import { insertOnce, type Queryable } from "@/db/client";
import { newCrmOutbox } from "@/db/schema";

export type CrmEventType = "contact_upsert" | "consent_changed";

/** Queues one event; a second call with the same idempotency key does nothing. */
export async function enqueueCrm(
  q: Queryable,
  playerId: string,
  type: CrmEventType,
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Promise<void> {
  await insertOnce(
    q.crmOutbox,
    { idempotencyKey },
    newCrmOutbox({ playerId, type, payload, idempotencyKey }),
  );
}
