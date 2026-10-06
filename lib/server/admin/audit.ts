/**
 * Audit log of everything an admin does that changes data or reads personal data in bulk
 * (SEC-09). Details hold ids and settings, never a player's email or name.
 */
import type { Queryable } from "@/db/client";
import { adminAudit } from "@/db/schema";

export async function audit(
  q: Queryable,
  admin: string,
  action: string,
  target: string | null = null,
  details: Record<string, unknown> = {},
): Promise<void> {
  await q.insert(adminAudit).values({ adminEmail: admin, action, target, details });
}
