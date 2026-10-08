"use client";

import { POINTS_PER_GARLIC, POINTS_PER_METRE, WINNERS } from "@/game-core";
import type { Translator } from "@/i18n";
import type { CampaignState } from "@/lib/api";
import { EntryForm, type SaveSubmit } from "./SaveScreen";
import { useUi } from "./context";
import { BrandLogo, Overlay, PixelIcon, Tools } from "./parts";

/** Why scores don't count right now (not started, ended or switched off), or null when they do. */
export function campaignMessage(campaign: CampaignState | null, t: Translator): string | null {
  if (!campaign) return null;
  if (campaign.status === "not_started") {
    return t.t("campaign.notStarted", { date: campaign.startsAt ? t.date(campaign.startsAt) : "" });
  }
  if (campaign.status === "ended") return t.t("campaign.ended");
  if (!campaign.leaderboardOpen) return t.t("campaign.paused");
  return null;
}

/** How a run scores, and who wins: two tiles and the winners' band. */
function ScoringPanel() {
  const { t } = useUi();
  const pts = (n: number) => t.plural("common.pts", n, { n: t.num(n) });
  return (
    <section className="scoring" aria-label={t.t("start.scoring")} data-testid="scoring">
      <div className="scoring-tiles">
        <p className="scoring-tile">
          <PixelIcon name="run1" />
          <span>
            <b>{pts(POINTS_PER_METRE)}</b> {t.t("start.perMetre")}
          </span>
        </p>
        <p className="scoring-tile">
          <PixelIcon name="cup" />
          <span>
            <b>{pts(POINTS_PER_GARLIC)}</b> {t.t("start.perGarlic")}
          </span>
        </p>
      </div>
      <p className="scoring-band">{t.t("start.winners", { n: WINNERS })}</p>
    </section>
  );
}

/** Start screen (§3.2): logo, title, how scoring works, PLAY, how to play, toggles, links. */
export function StartScreen({
  campaign,
  starting,
  onPlay,
  onLeaderboard,
}: {
  campaign: CampaignState | null;
  starting: boolean;
  onPlay: SaveSubmit;
  onLeaderboard: () => void;
}) {
  const { t } = useUi();
  const message = campaignMessage(campaign, t);
  return (
    <Overlay labelledBy="start-title" spark>
      <div className="card-bar">
        <BrandLogo />
        <Tools />
      </div>
      <p className="kicker">{t.t("start.kicker")}</p>
      <h1 id="start-title" className="title" tabIndex={-1} data-autofocus>
        {t.t("brand.titleTop")}
        <br />
        {t.t("brand.titleBottom")}
      </h1>
      <p className="lede">{t.t("start.lede")}</p>
      {message ? <p className="campaign-note">{message}</p> : <ScoringPanel />}
      <EntryForm onSubmit={onPlay} disabled={starting} />
      <p className="small">{t.t("start.how")}</p>
      <div className="btn-stack">
        <button type="button" className="btn ghost" onClick={onLeaderboard}>
          {t.t("common.leaderboard")}
        </button>
      </div>
    </Overlay>
  );
}
