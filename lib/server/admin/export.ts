/**
 * Claimers export (ADM-06, CRM-02): one row per player who claimed at least one reward, with
 * every consent field, so the file can be imported into a CRM by hand. The newest consent row
 * of each kind is the current one; the full history stays in the player's record.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Queryable } from "@/db/client";
import { claims, codes, consents, players } from "@/db/schema";
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
  const people = await q
    .select()
    .from(players)
    .where(
      and(
        isNull(players.deletedAt),
        optedInOnly ? eq(players.marketingOptIn, true) : undefined,
        sql`exists (select 1 from ${claims} where ${claims.playerId} = ${players.id})`,
      ),
    )
    .orderBy(asc(players.createdAt), asc(players.id));

  const rows: unknown[][] = [];
  for (let i = 0; i < people.length; i += CHUNK) {
    const slice = people.slice(i, i + CHUNK);
    const ids = slice.map((p) => p.id);
    const held = await q
      .select({
        playerId: claims.playerId,
        reward: claims.rewardId,
        code: codes.code,
        at: claims.createdAt,
      })
      .from(claims)
      .leftJoin(codes, eq(codes.id, claims.codeId))
      .where(inArray(claims.playerId, ids))
      .orderBy(asc(claims.createdAt));
    const log = await q
      .select()
      .from(consents)
      .where(inArray(consents.playerId, ids))
      .orderBy(asc(consents.createdAt), asc(consents.id));

    for (const p of slice) {
      const mine = held.filter((h) => h.playerId === p.id);
      const history = log.filter((c) => c.playerId === p.id);
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
        mine.map((h) => h.reward).join("; "),
        mine.map((h) => `${h.reward}:${h.code ?? ""}`).join("; "),
        p.firstSrc,
        p.utm.utm_source,
        p.utm.utm_medium,
        p.utm.utm_campaign,
        p.utm.utm_content,
        p.firstHost,
        mine[0]?.at,
        p.createdAt,
        p.emailBlockedAt ? (p.emailBlockReason ?? "yes") : "no",
      ]);
    }
  }
  return toCsv(CLAIMER_COLUMNS, rows);
}
