"use client";

import { WINNERS } from "@/game-core";
import type { CampaignState } from "@/lib/api";
import { useUi } from "./context";
import { OutLink, Overlay, Tools } from "./parts";

/**
 * After "Save my score" (LB-02): the player's rank and points on the board, how the contest is
 * won, and the way to the counter (EMB-09).
 */
export function SavedScreen({
  rank,
  points,
  campaign,
  onPlayAgain,
  onLeaderboard,
}: {
  /** Null when the player isn't shown on the board. */
  rank: number | null;
  /** The player's best, as the board shows it. */
  points: number;
  campaign: CampaignState | null;
  onPlayAgain: () => void;
  onLeaderboard: () => void;
}) {
  const { t } = useUi();
  const endsAt = campaign?.endsAt;
  return (
    <Overlay labelledBy="saved-title" spark>
      <div className="card-bar">
        <Tools />
      </div>
      <h2 id="saved-title" className="heading" tabIndex={-1} data-autofocus>
        {rank !== null ? t.t("saved.title") : t.t("saved.titleNoRank")}
      </h2>
      <dl className="standing" data-testid="saved">
        {rank !== null && (
          <div>
            <dt>{t.t("saved.rank")}</dt>
            <dd>#{t.num(rank)}</dd>
          </div>
        )}
        <div>
          <dt>{t.plural("results.points", points)}</dt>
          <dd>{t.num(points)}</dd>
        </div>
      </dl>
      <p className="sub">
        {endsAt
          ? t.t("saved.winnersUntil", { n: WINNERS, date: t.date(endsAt) })
          : t.t("saved.winners", { n: WINNERS })}
      </p>
      <div className="btn-stack">
        <button type="button" className="btn primary big" onClick={onPlayAgain}>
          {t.t("common.playAgain")}
        </button>
        <button type="button" className="btn" onClick={onLeaderboard}>
          {t.t("common.leaderboard")}
        </button>
        <div className="btn-row">
          <OutLink target="orderOnline" className="btn ghost">
            {t.t("common.orderOnline")}
          </OutLink>
          <OutLink target="findBoustan" className="btn ghost">
            {t.t("common.findBoustan")}
          </OutLink>
        </div>
      </div>
    </Overlay>
  );
}
