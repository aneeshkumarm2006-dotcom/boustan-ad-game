/**
 * Data retention (DATA-06): players who did not opt in to marketing are anonymized a set
 * number of days after the contest ends (90 by default, editable in the campaign settings).
 * Opted-in contacts follow Boustan's own CRM policy. The current winners (the top `WINNERS` on
 * the board) are kept, so Boustan can still reach them.
 */
import type { Filter } from "mongodb";
import type { Db, Queryable } from "@/db/client";
import type { PlayerDoc } from "@/db/schema";
import { audit } from "./audit";
import { winnerIds } from "./moderation";
import { erasePlayer } from "./players";

export const RETENTION_ACTOR = "system:retention";

/** When the purge starts, or null while the contest has no end date. */
export async function purgeDate(q: Queryable): Promise<Date | null> {
  const s = await q.campaignSettings.findOne({ _id: 1 });
  if (!s?.endsAt) return null;
  return new Date(s.endsAt.getTime() + s.retentionDays * 86_400_000);
}

/** Players who did not opt in, aren't erased yet and aren't one of the current winners. */
async function eligible(q: Queryable): Promise<Filter<PlayerDoc>> {
  const keep = await winnerIds(q);
  return {
    deletedAt: null,
    marketingOptIn: false,
    ...(keep.length > 0 ? { _id: { $nin: keep } } : {}),
  };
}

/** How many players the purge would anonymize now (0 before the purge date). */
export async function retentionDue(q: Queryable, now = new Date()): Promise<number> {
  const date = await purgeDate(q);
  if (!date || now < date) return 0;
  return q.players.countDocuments(await eligible(q));
}

export interface RetentionResult {
  /** False while the contest has no end date or the purge date hasn't come. */
  due: boolean;
  anonymized: number;
  remaining: number;
}

/**
 * Anonymizes up to `batch` eligible players, oldest first; the daily cron keeps going until
 * none remain. Erasing never touches a winner, so the winners stay the same from one batch to
 * the next.
 */
export async function runRetention(q: Db, now = new Date(), batch = 500): Promise<RetentionResult> {
  const date = await purgeDate(q);
  if (!date || now < date) return { due: false, anonymized: 0, remaining: 0 };
  const ids = await q.players
    .find(await eligible(q), { projection: { _id: 1 } })
    .sort({ createdAt: 1 })
    .limit(batch)
    .toArray();
  let anonymized = 0;
  for (const { _id } of ids) {
    if (await erasePlayer(q, _id, now)) anonymized++;
  }
  if (anonymized > 0) {
    await audit(q, RETENTION_ACTOR, "retention.purge", "players", {
      anonymized,
      purgeDate: date.toISOString(),
    });
  }
  return { due: true, anonymized, remaining: await retentionDue(q, now) };
}
