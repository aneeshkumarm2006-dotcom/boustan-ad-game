"use client";

import { POINTS_PER_GARLIC, POINTS_PER_METRE, WINNERS, type RunScore } from "@/game-core";
import type { CampaignState, FinishRunResponse, LeaderboardResponse } from "@/lib/api";
import type { RunResult } from "../engine";
import { useUi } from "./context";
import { BoardTable, BrandLogo, Overlay, Tools } from "./parts";
import { SaveScreen, type SaveErrorKey } from "./SaveScreen";
import { campaignMessage } from "./StartScreen";

export type FinishState =
  | { status: "pending" }
  | { status: "offline" }
  | { status: "error" }
  | { status: "done"; res: FinishRunResponse };

/** Results screen (§3.2): the run's points and how they add up, its status, the top 3. */
export function ResultsScreen({
  result,
  finish,
  campaign,
  best,
  newBest,
  preview,
  onSubmit,
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
  /** The top of the board, fetched after a valid run. */
  preview: LeaderboardResponse | null;
  onSubmit: (token: string) => Promise<SaveErrorKey | null>;
  onRetryFinish: () => void;
  onPlayAgain: () => void;
  onShare: () => void;
  onLeaderboard: () => void;
}) {
  const { t } = useUi();
  const res = finish.status === "done" && finish.res.valid ? finish.res : null;
  // Valid runs always get a rank preview while the leaderboard is open, so none means closed.
  const closed = res !== null && res.rankPreview === null;
  // A known device's run was saved when it finished (LB-02), so only a new player saves.
  const canSave = res !== null && !closed && res.saveToken !== null;

  let note: { text: string; kind: "" | "warn" | "ok" };
  if (finish.status === "pending") note = { text: t.t("results.checking"), kind: "" };
  else if (finish.status !== "done") note = { text: t.t("results.offline"), kind: "warn" };
  else if (!res) note = { text: t.t("results.invalid"), kind: "warn" };
  else if (closed)
    note = { text: campaignMessage(campaign, t) ?? t.t("results.closed"), kind: "warn" };
  else if (canSave) note = { text: t.t("results.savePrompt", { n: WINNERS }), kind: "" };
  // A hidden player's run is saved too, but has no rank to show.
  else if (res.rank === null) note = { text: t.t("results.savedNoRank"), kind: "ok" };
  else note = { text: t.t("results.saved", { rank: t.num(res.rank) }), kind: "ok" };

  const metres = Math.floor(result.distanceM);
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
      <div className="score" data-testid="score">
        <p className="score-total">
          <b data-testid="points">{t.num(result.points)}</b>
          <span>{t.plural("results.points", result.points)}</span>
        </p>
        <dl className="score-lines">
          <dt data-testid="by-distance">
            {t.t("results.byDistance", { m: t.num(metres), x: POINTS_PER_METRE })}
          </dt>
          <dd>{t.num(metres * POINTS_PER_METRE)}</dd>
          <dt data-testid="by-garlic">
            {t.plural("results.byGarlic", result.garlic, {
              n: t.num(result.garlic),
              x: POINTS_PER_GARLIC,
            })}
          </dt>
          <dd>{t.num(result.garlic * POINTS_PER_GARLIC)}</dd>
        </dl>
        <p className="score-hits" data-testid="hits">
          {t.plural("results.hits", result.hits, { n: t.num(result.hits) })}
        </p>
      </div>
      {canSave && <SaveScreen onSubmit={onSubmit} />}
      {newBest && <p className="badge">{t.t("results.newBest")}</p>}
      {best && !newBest && (
        <p className="small">
          {t.plural("results.bestLine", best.points, { points: t.num(best.points) })}
        </p>
      )}
      <p className={`note ${note.kind}`} role="status">
        {note.text}
      </p>
      {res && preview && preview.top.length > 0 && (
        <section className="preview" aria-labelledby="preview-title">
          <p id="preview-title" className="kicker">
            {t.t("lb.title")}
          </p>
          <BoardTable rows={preview.top} me={preview.me} />
          {canSave && res.rankPreview !== null && (
            <p className="small">{t.t("results.wouldRank", { rank: t.num(res.rankPreview) })}</p>
          )}
        </section>
      )}
      <div className="btn-stack">
        {finish.status === "error" && (
          <button type="button" className="btn" onClick={onRetryFinish}>
            {t.t("common.retry")}
          </button>
        )}
        <div className="btn-row">
          <button
            type="button"
            className={canSave ? "btn" : "btn primary"}
            onClick={onPlayAgain}
            data-autofocus={canSave ? undefined : true}
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
