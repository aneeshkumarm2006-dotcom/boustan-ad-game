"use client";

import { DEFAULT_REWARD_RULES, type RunScore } from "@/game-core";
import type { CampaignState, FinishRunResponse, LeaderboardEntry } from "@/lib/api";
import type { RunResult } from "../engine";
import { useUi } from "./context";
import { BrandLogo, Overlay, RewardCard, Tools, type RewardStatus } from "./parts";

export type FinishState =
  | { status: "pending" }
  | { status: "offline" }
  | { status: "error" }
  | { status: "done"; res: FinishRunResponse };

/** Results screen (§3.2). */
export function ResultsScreen({
  result,
  finish,
  campaign,
  best,
  newBest,
  preview,
  savedRank,
  onClaim,
  onRetryFinish,
  onPlayAgain,
  onShare,
  onLeaderboard,
}: {
  result: RunResult;
  finish: FinishState;
  campaign: CampaignState | null;
  best: RunScore | null;
  newBest: boolean;
  preview: LeaderboardEntry[] | null;
  savedRank: number | null;
  onClaim: (mode: "claim" | "save") => void;
  onRetryFinish: () => void;
  onPlayAgain: () => void;
  onShare: () => void;
  onLeaderboard: () => void;
}) {
  const { t } = useUi();
  const rules = campaign?.rules ?? DEFAULT_REWARD_RULES;
  const res = finish.status === "done" ? finish.res : null;
  const valid = res?.valid === true;
  const claimable = valid ? res.unlocked : [];
  // A returning player's best was saved when the run finished (LB-02): nothing left to save.
  const rank = savedRank ?? (valid ? res.rank : null);

  const statusOf = (id: (typeof result.unlocked)[number]): RewardStatus => {
    if (finish.status === "offline" || finish.status === "error") return "offline";
    if (finish.status === "pending") return "unlocked";
    return claimable.includes(id) ? "unlocked" : "gone";
  };

  let note: { text: string; kind: "" | "warn" | "ok" } | null = null;
  if (finish.status === "pending") note = { text: t.t("results.checking"), kind: "" };
  else if (finish.status === "offline" || finish.status === "error")
    note = { text: t.t("results.offline"), kind: "warn" };
  else if (!valid) note = { text: t.t("results.invalid"), kind: "warn" };
  else if (savedRank !== null)
    note = { text: t.t("results.scoreSaved", { rank: t.num(savedRank) }), kind: "ok" };
  else if (claimable.length > 0) note = { text: t.t("results.claimWindow"), kind: "" };
  else if (rank !== null)
    note = { text: t.t("results.scoreSaved", { rank: t.num(rank) }), kind: "ok" };
  else if (result.unlocked.length === 0)
    note = {
      text: t.t("results.nothingUnlocked", {
        m: rules.free_coke.distanceM,
        n: rules.free_garlic_sauce.garlic,
      }),
      kind: "",
    };

  const showBest = best && !newBest;
  return (
    <Overlay labelledBy="results-title" focusKey={finish.status}>
      <div className="card-bar">
        <BrandLogo small />
        <Tools />
      </div>
      <h2 id="results-title" className="heading">
        {t.t("results.title")}
      </h2>
      <p className="sub">{t.t(`results.death.${result.cause}`)}</p>
      <div className="stats" data-testid="stats">
        <div className="stat">
          <b>{t.num(result.distanceM)} m</b>
          <span>{t.t("results.distance")}</span>
        </div>
        <div className="stat">
          <b>{t.num(result.garlic)}</b>
          <span>{t.t("results.garlic")}</span>
        </div>
        <div className="stat">
          <b>{t.num(result.hits)}</b>
          <span>{t.t("results.hits")}</span>
        </div>
      </div>
      {newBest && <p className="badge">{t.t("results.newBest")}</p>}
      {showBest && (
        <p className="small">
          {t.t("results.bestLine", {
            distance: t.num(best.distanceM),
            garlic: t.num(best.garlic),
            hits: t.num(best.hits),
          })}
        </p>
      )}
      {result.unlocked.length > 0 && (finish.status !== "done" || valid) && (
        <section aria-labelledby="unlocked-title">
          <p id="unlocked-title" className="kicker">
            {t.t("results.unlockedTitle")}
          </p>
          <div className="rewards">
            {result.unlocked.map((id) => (
              <RewardCard key={id} id={id} rules={rules} status={statusOf(id)} />
            ))}
          </div>
        </section>
      )}
      {note && (
        <p className={`note ${note.kind}`} role="status">
          {note.text}
        </p>
      )}
      {valid && preview && preview.length > 0 && (
        <section aria-label={t.t("lb.title")}>
          <p className="kicker">{t.t("lb.title")}</p>
          <p className="small" aria-hidden="true" style={{ textAlign: "right" }}>
            {t.t("lb.garlic")} · {t.t("lb.hits")} · {t.t("lb.distance")}
          </p>
          <ol className="mini-board">
            {preview.map((e) => (
              <li key={e.rank}>
                <span>
                  #{e.rank} {e.name}
                </span>
                <span>
                  {t.num(e.garlic)} · {t.num(e.hits)} · {t.num(e.distanceM)} m
                </span>
              </li>
            ))}
          </ol>
          {res?.rankPreview != null && rank === null && (
            <p className="small">{t.t("results.rankPreview", { rank: t.num(res.rankPreview) })}</p>
          )}
        </section>
      )}
      <div className="btn-stack">
        {claimable.length > 0 && (
          <button
            type="button"
            className="btn primary big"
            onClick={() => onClaim("claim")}
            data-autofocus
          >
            {claimable.length > 1 ? t.t("results.claimMany") : t.t("claim.cta")}
          </button>
        )}
        {valid && claimable.length === 0 && rank === null && (
          <button
            type="button"
            className="btn primary big"
            onClick={() => onClaim("save")}
            data-autofocus
          >
            {t.t("results.saveScore")}
          </button>
        )}
        {finish.status === "error" && (
          <button type="button" className="btn" onClick={onRetryFinish}>
            {t.t("common.retry")}
          </button>
        )}
        <div className="btn-row">
          <button
            type="button"
            className={claimable.length > 0 || (valid && rank === null) ? "btn" : "btn primary"}
            onClick={onPlayAgain}
            data-autofocus={claimable.length === 0 && !(valid && rank === null) ? true : undefined}
          >
            {t.t("common.playAgain")}
          </button>
          <button type="button" className="btn" onClick={onShare}>
            {t.t("results.share")}
          </button>
        </div>
        <button type="button" className="btn ghost" onClick={onLeaderboard}>
          {t.t("common.leaderboard")}
        </button>
      </div>
    </Overlay>
  );
}
