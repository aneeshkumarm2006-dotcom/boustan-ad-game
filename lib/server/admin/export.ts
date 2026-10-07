/**
 * Players export (ADM-06, CRM-02): one row per player on the leaderboard, in board order, with
 * the score and every consent field, so Boustan can reach the winners and import the file into
 * a CRM by hand. The newest consent row of each kind is the current one; the full history stays
 * in the player's record.
 */
import type { Queryable } from "@/db/client";
import type { BestRunDoc } from "@/db/schema";
import { WINNERS } from "@/game-core";
import { toCsv } from "@/lib/csv";
import { RANK_ORDER } from "../leaderboard";
import { topBestRuns } from "./moderation";

export const PLAYER_COLUMNS = [
  "rank",
  "email",
  "nickname",
  "points",
  "distance_m",
  "garlic",
  "achieved_at",
  "language",
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
  "first_src",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "first_host",
  "created_at",
  "hidden",
];

const CHUNK = 5000;

export interface PlayersCsvOptions {
  /** Only the current winners: the first `WINNERS` visible rows. */
  winnersOnly?: boolean;
  /** Only players who opted in to offers. Ranks stay those of the whole board. */
  optedInOnly?: boolean;
}

export async function playersCsv(
  q: Queryable,
  { winnersOnly = false, optedInOnly = false }: PlayersCsvOptions = {},
): Promise<string> {
  // Erased players have no best run, so the board is exactly the players to list.
  const board: BestRunDoc[] = winnersOnly
    ? await topBestRuns(q, WINNERS)
    : await q.bestRuns.find().sort(RANK_ORDER).toArray();

  const rows: unknown[][] = [];
  // Rank counts visible players only, as on the public board; a hidden player's is blank.
  let rank = 0;
  for (let i = 0; i < board.length; i += CHUNK) {
    const slice = board.slice(i, i + CHUNK);
    const people = await q.players
      .find({ _id: { $in: slice.map((b) => b._id) }, deletedAt: null })
      .toArray();
    const byId = new Map(people.map((p) => [p._id, p]));
    const log = await q.consents
      .find({ playerId: { $in: people.map((p) => p._id) } })
      .sort({ createdAt: 1, _id: 1 })
      .toArray();
    const historyOf = Map.groupBy(log, (c) => c.playerId);

    for (const best of slice) {
      const p = byId.get(best._id);
      if (!p) continue;
      const place = p.hidden ? null : ++rank;
      if (optedInOnly && !p.marketingOptIn) continue;
      const history = historyOf.get(p._id) ?? [];
      const terms = history.filter((c) => c.kind === "terms_age" && c.granted).at(-1);
      const marketing = history.filter((c) => c.kind === "marketing").at(-1);
      rows.push([
        place,
        p.email,
        p.nickname,
        best.points,
        Math.floor(best.distanceM),
        best.garlic,
        best.achievedAt,
        p.language,
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
        p.firstSrc,
        p.utm.utm_source,
        p.utm.utm_medium,
        p.utm.utm_campaign,
        p.utm.utm_content,
        p.firstHost,
        p.createdAt,
        p.hidden ? "yes" : "no",
      ]);
    }
  }
  return toCsv(PLAYER_COLUMNS, rows);
}
