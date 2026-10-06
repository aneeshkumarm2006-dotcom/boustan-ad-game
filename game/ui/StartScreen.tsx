"use client";

import { DEFAULT_REWARD_RULES, REWARD_IDS } from "@/game-core";
import type { CampaignState } from "@/lib/api";
import { useUi } from "./context";
import { BrandLogo, Overlay, RewardCard, Tools } from "./parts";

export function campaignMessage(
  campaign: CampaignState | null,
  t: ReturnType<typeof useUi>["t"],
): string | null {
  if (!campaign) return null;
  if (campaign.status === "not_started") {
    return t.t("start.notStarted", { date: campaign.startsAt ? t.date(campaign.startsAt) : "" });
  }
  if (campaign.status === "ended") return t.t("start.ended");
  if (!campaign.claimsEnabled) return t.t("start.claimsOff");
  return null;
}

/** Start screen (§3.2): logo, title, reward cards, PLAY, how to play, toggles, links. */
export function StartScreen({
  campaign,
  starting,
  hasRewards,
  hasPending,
  onPlay,
  onLeaderboard,
  onMyRewards,
  onClaimPending,
}: {
  campaign: CampaignState | null;
  starting: boolean;
  hasRewards: boolean;
  hasPending: boolean;
  onPlay: () => void;
  onLeaderboard: () => void;
  onMyRewards: () => void;
  onClaimPending: () => void;
}) {
  const { t } = useUi();
  const rules = campaign?.rules ?? DEFAULT_REWARD_RULES;
  const message = campaignMessage(campaign, t);
  return (
    <Overlay labelledBy="start-title">
      <div className="card-bar">
        <BrandLogo />
        <Tools />
      </div>
      <p className="kicker">{t.t("start.kicker")}</p>
      <h1 id="start-title" className="title">
        {t.t("brand.titleTop")}
        <br />
        {t.t("brand.titleBottom")}
      </h1>
      <p className="lede">{t.t("start.lede")}</p>
      {message ? (
        <p className="campaign-note">{message}</p>
      ) : (
        <section aria-label={t.t("start.rewardsTitle")}>
          <p className="kicker">{t.t("start.rewardsTitle")}</p>
          <div className="rewards">
            {REWARD_IDS.map((id) => (
              <RewardCard
                key={id}
                id={id}
                rules={rules}
                status={campaign && !campaign.rewards[id].available ? "gone" : "open"}
              />
            ))}
          </div>
        </section>
      )}
      {hasPending && (
        <div className="btn-stack">
          <p className="note warn">{t.t("start.pending")}</p>
          <button type="button" className="btn" onClick={onClaimPending}>
            {t.t("claim.cta")}
          </button>
        </div>
      )}
      <button
        type="button"
        className="btn primary big"
        onClick={onPlay}
        disabled={starting}
        data-autofocus
        data-testid="play"
      >
        {starting ? t.t("start.getReady") : t.t("start.play")}
      </button>
      <p className="small">{t.t("start.how")}</p>
      <div className={hasRewards ? "btn-row" : "btn-stack"}>
        <button type="button" className="btn ghost" onClick={onLeaderboard}>
          {t.t("common.leaderboard")}
        </button>
        {hasRewards && (
          <button type="button" className="btn ghost" onClick={onMyRewards}>
            {t.t("common.myRewards")}
          </button>
        )}
      </div>
    </Overlay>
  );
}
