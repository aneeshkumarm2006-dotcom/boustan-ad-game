"use client";

import { useEffect, useState } from "react";
import { POINTS_PER_GARLIC, POINTS_PER_METRE, WINNERS } from "@/game-core";
import type { CampaignState, GameApi, LeaderboardResponse } from "@/lib/api";
import { useUi } from "./context";
import { BackArrow, BoardTable, Overlay, Tools, isOwnRow } from "./parts";

/**
 * Leaderboard (LB-04): the top 10 by points plus the player's own row. The top 3 win, and are
 * marked so. Never shows emails.
 */
export function LeaderboardScreen({
  api,
  playerToken,
  campaign,
  onBack,
}: {
  api: GameApi;
  playerToken: string | undefined;
  campaign: CampaignState | null;
  onBack: () => void;
}) {
  const { t, emit } = useUi();
  const [data, setData] = useState<LeaderboardResponse | null | "error">(null);

  useEffect(() => {
    emit({ type: "leaderboard_view" });
    let live = true;
    api.leaderboard(10, playerToken).then(
      (res) => live && setData(res),
      () => live && setData("error"),
    );
    return () => {
      live = false;
    };
  }, [api, playerToken, emit]);

  const board = data && data !== "error" ? data : null;
  const me = board?.me;
  const meInTop = board !== null && board.top.some((e) => isOwnRow(e, me));
  const rows = board ? [...board.top, ...(me && !meInTop ? [me] : [])] : [];
  const endsAt = campaign?.endsAt;
  const contest =
    campaign?.status === "ended"
      ? t.t("lb.final", { n: WINNERS })
      : endsAt
        ? t.t("lb.liveUntil", { n: WINNERS, date: t.date(endsAt) })
        : t.t("lb.live", { n: WINNERS });

  return (
    <Overlay labelledBy="lb-title">
      <div className="card-bar">
        <button type="button" className="linkish" onClick={onBack} data-autofocus>
          <BackArrow /> {t.t("common.back")}
        </button>
        <Tools />
      </div>
      <h2 id="lb-title" className="heading">
        {t.t("lb.title")}
      </h2>
      <p className="sub" data-testid="contest">
        {contest}
      </p>
      {data === null && <p className="note">{t.t("common.loading")}</p>}
      {data === "error" && <p className="note warn">{t.t("lb.error")}</p>}
      {board && rows.length === 0 && <p className="note">{t.t("lb.empty")}</p>}
      {rows.length > 0 && (
        <BoardTable
          rows={rows}
          me={me}
          caption={t.t("lb.caption", { m: POINTS_PER_METRE, g: POINTS_PER_GARLIC })}
        />
      )}
      {me && !meInTop && <p className="small">{t.t("lb.you", { rank: t.num(me.rank) })}</p>}
    </Overlay>
  );
}
