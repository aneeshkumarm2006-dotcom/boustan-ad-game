/**
 * Data retention (DATA-06): players who did not opt in to marketing are anonymized a set
 * number of days after the campaign ends (90 by default, editable in the campaign settings).
 * Opted-in contacts follow Boustan's own CRM policy. A player who still holds a code that
 * hasn't expired is kept until it does, so a lost-email re-send keeps working.
 */
import type { Document } from "mongodb";
import type { Db, Queryable } from "@/db/client";
import { audit } from "./audit";
import { erasePlayer } from "./players";

export const RETENTION_ACTOR = "system:retention";

/** When the purge starts, or null while the campaign has no end date. */
export async function purgeDate(q: Queryable): Promise<Date | null> {
  const s = await q.campaignSettings.findOne({ _id: 1 });
  if (!s?.endsAt) return null;
  return new Date(s.endsAt.getTime() + s.retentionDays * 86_400_000);
}

/**
 * Players who did not opt in, aren't erased yet and hold no claim whose code is still valid.
 * `oldestFirst` puts the sort ahead of the claim lookup, so a batch stops looking once it is
 * full instead of checking every player.
 */
function eligible(now: Date, oldestFirst = false): Document[] {
  return [
    { $match: { deletedAt: null, marketingOptIn: false } },
    ...(oldestFirst ? [{ $sort: { createdAt: 1 } }] : []),
    {
      $lookup: {
        from: "claims",
        localField: "_id",
        foreignField: "playerId",
        pipeline: [{ $match: { expiresAt: { $gt: now } } }, { $limit: 1 }],
        as: "live",
      },
    },
    { $match: { live: { $size: 0 } } },
  ];
}

/** How many players the purge would anonymize now (0 before the purge date). */
export async function retentionDue(q: Queryable, now = new Date()): Promise<number> {
  const date = await purgeDate(q);
  if (!date || now < date) return 0;
  const [row] = await q.players
    .aggregate<{ n: number }>([...eligible(now), { $count: "n" }])
    .toArray();
  return row?.n ?? 0;
}

export interface RetentionResult {
  /** False while the campaign has no end date or the purge date hasn't come. */
  due: boolean;
  anonymized: number;
  remaining: number;
}

/** Anonymizes up to `batch` eligible players; the daily cron keeps going until none remain. */
export async function runRetention(q: Db, now = new Date(), batch = 500): Promise<RetentionResult> {
  const date = await purgeDate(q);
  if (!date || now < date) return { due: false, anonymized: 0, remaining: 0 };
  const ids = await q.players
    .aggregate<{ _id: string }>([
      ...eligible(now, true),
      { $limit: batch },
      { $project: { _id: 1 } },
    ])
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
