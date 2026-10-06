/**
 * Unsubscribe (DATA-07, CASL, AC-07): a signed link in every email. It logs a withdrawal in the
 * consent log, turns marketing off and queues the change for the CRM (CRM-07: unsubscribes are
 * always passed on). Repeat clicks log again; that's harmless and keeps the record complete.
 */
import type { Db } from "@/db/client";
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
    const player = await tx.players.findOne({ _id: payload.p, deletedAt: null });
    if (!player) return null;
    const lang: Lang = isLang(player.language) ? player.language : "fr";
    await recordConsent(tx, {
      playerId: player._id,
      kind: "marketing",
      granted: false,
      lang,
      source: "unsubscribe",
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      hostOrigin: null,
    });
    await tx.players.updateOne({ _id: player._id }, { $set: { marketingOptIn: false } });
    await enqueueCrm(
      tx,
      player._id,
      "consent_changed",
      { marketing: false, source: "unsubscribe" },
      `consent:${player._id}:${ctx.now.getTime()}:unsubscribe`,
    );
    return { lang };
  });
}
