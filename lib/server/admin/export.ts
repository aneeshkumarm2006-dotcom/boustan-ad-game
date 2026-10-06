/**
 * Claimers export (ADM-06, CRM-02): one row per player who claimed at least one reward, with
 * every consent field, so the file can be imported into a CRM by hand. The newest consent row
 * of each kind is the current one; the full history stays in the player's record.
 */
import type { Queryable } from "@/db/client";
import type { PlayerDoc } from "@/db/schema";
import { toCsv } from "@/lib/csv";

export const CLAIMER_COLUMNS = [
  "email",
  "language",
  "nickname",
  "marketing_opt_in",
  "terms_age_accepted_at",
  "terms_age_text_version",
  "terms_age_text",
  "marketing_status",
  "marketing_changed_at",
  "marketing_text_version",
  "marketing_text",
  "marketing_language",
  "marketing_source",
  "marketing_ip",
  "marketing_user_agent",
  "marketing_host_origin",
  "rewards",
  "codes",
  "first_src",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "first_host",
  "first_claim_at",
  "created_at",
  "email_blocked",
];

const CHUNK = 5000;

export async function claimersCsv(q: Queryable, optedInOnly: boolean): Promise<string> {
  // Everyone holding a claim, then the players among them who qualify, oldest first.
  const claimers = (
    await q.claims.aggregate<{ _id: string }>([{ $group: { _id: "$playerId" } }]).toArray()
  ).map((c) => c._id);
  const people: PlayerDoc[] = [];
  for (let i = 0; i < claimers.length; i += CHUNK) {
    people.push(
      ...(await q.players
        .find({
          _id: { $in: claimers.slice(i, i + CHUNK) },
          deletedAt: null,
          ...(optedInOnly ? { marketingOptIn: true } : {}),
        })
        .toArray()),
    );
  }
  people.sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0),
  );

  const rows: unknown[][] = [];
  for (let i = 0; i < people.length; i += CHUNK) {
    const slice = people.slice(i, i + CHUNK);
    const ids = slice.map((p) => p._id);
    const claimRows = await q.claims
      .find({ playerId: { $in: ids } })
      .sort({ createdAt: 1 })
      .toArray();
    const codeDocs = await q.codes
      .find({ _id: { $in: claimRows.flatMap((c) => (c.codeId ? [c.codeId] : [])) } })
      .toArray();
    const codeOf = new Map(codeDocs.map((c) => [c._id.toHexString(), c.code]));
    const log = await q.consents
      .find({ playerId: { $in: ids } })
      .sort({ createdAt: 1, _id: 1 })
      .toArray();

    for (const p of slice) {
      const mine = claimRows.filter((h) => h.playerId === p._id);
      const history = log.filter((c) => c.playerId === p._id);
      const terms = history.filter((c) => c.kind === "terms_age" && c.granted).at(-1);
      const marketing = history.filter((c) => c.kind === "marketing").at(-1);
      rows.push([
        p.email,
        p.language,
        p.nickname,
        p.marketingOptIn ? "yes" : "no",
        terms?.createdAt,
        terms?.textVersion,
        terms?.text,
        marketing ? (marketing.granted ? "granted" : "withdrawn") : "none",
        marketing?.createdAt,
        marketing?.textVersion,
        marketing?.text,
        marketing?.language,
        marketing?.source,
        marketing?.ip,
        marketing?.userAgent,
        marketing?.hostOrigin,
        mine.map((h) => h.rewardId).join("; "),
        mine
          .map((h) => `${h.rewardId}:${(h.codeId && codeOf.get(h.codeId.toHexString())) ?? ""}`)
          .join("; "),
        p.firstSrc,
        p.utm.utm_source,
        p.utm.utm_medium,
        p.utm.utm_campaign,
        p.utm.utm_content,
        p.firstHost,
        mine[0]?.createdAt,
        p.createdAt,
        p.emailBlockedAt ? (p.emailBlockReason ?? "yes") : "no",
      ]);
    }
  }
  return toCsv(CLAIMER_COLUMNS, rows);
}
