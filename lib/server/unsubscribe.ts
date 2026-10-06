/**
 * Unsubscribe (DATA-07, CASL, AC-07): a signed link in every email. It logs a withdrawal in the
 * consent log, turns marketing off and queues the change for the CRM (CRM-07: unsubscribes are
 * always passed on). Repeat clicks log again; that's harmless and keeps the record complete.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { players } from "@/db/schema";
import { isLang, type Lang } from "@/i18n";
import { recordConsent } from "./consent";
import { enqueueCrm } from "./crm-outbox";
import { unsubscribeTokenSchema, verifyToken } from "./tokens";

export async function unsubscribe(
  q: Db,
  token: string,
  ctx: { ip: string | null; userAgent: string | null; now: Date },
): Promise<{ lang: Lang } | null> {
  const payload = verifyToken("unsubscribe", token, unsubscribeTokenSchema);
  if (!payload) return null;
  return q.transaction(async (tx) => {
    const [player] = await tx
      .select()
      .from(players)
      .where(and(eq(players.id, payload.p), isNull(players.deletedAt)))
      .for("update");
    if (!player) return null;
    const lang: Lang = isLang(player.language) ? player.language : "fr";
    await recordConsent(tx, {
      playerId: player.id,
      kind: "marketing",
      granted: false,
      lang,
      source: "unsubscribe",
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      hostOrigin: null,
    });
    await tx.update(players).set({ marketingOptIn: false }).where(eq(players.id, player.id));
    await enqueueCrm(
      tx,
      player.id,
      "consent_changed",
      { marketing: false, source: "unsubscribe" },
      `consent:${player.id}:${ctx.now.getTime()}:unsubscribe`,
    );
    return { lang };
  });
}
