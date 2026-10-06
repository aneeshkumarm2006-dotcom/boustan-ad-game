"use client";

import { useEffect, useState } from "react";
import type { GameApi, IssuedCode, LeaderboardResponse } from "@/lib/api";
import { useUi } from "./context";
import { CodeCard } from "./CouponScreen";
import { Overlay, Tools } from "./parts";

/** Leaderboard (LB-04): top 10 plus the player's own row. Never shows emails. */
export function LeaderboardScreen({
  api,
  playerToken,
  onBack,
}: {
  api: GameApi;
  playerToken: string | undefined;
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

  const me = data && data !== "error" ? data.me : undefined;
  const meInTop = me && data !== "error" && data?.top.some((e) => e.rank === me.rank);
  const rows = data && data !== "error" ? [...data.top, ...(me && !meInTop ? [me] : [])] : [];

  return (
    <Overlay labelledBy="lb-title">
      <div className="card-bar">
        <button type="button" className="linkish" onClick={onBack} data-autofocus>
          ← {t.t("common.back")}
        </button>
        <Tools />
      </div>
      <h2 id="lb-title" className="heading">
        {t.t("lb.title")}
      </h2>
      {data === null && <p className="note">{t.t("common.loading")}</p>}
      {data === "error" && <p className="note warn">{t.t("lb.error")}</p>}
      {data && data !== "error" && rows.length === 0 && <p className="note">{t.t("lb.empty")}</p>}
      {rows.length > 0 && (
        <table className="board">
          <caption>{t.t("lb.caption")}</caption>
          <thead>
            <tr>
              <th scope="col">{t.t("lb.rank")}</th>
              <th scope="col">{t.t("lb.name")}</th>
              <th scope="col">{t.t("lb.garlic")}</th>
              <th scope="col">{t.t("lb.hits")}</th>
              <th scope="col">{t.t("lb.distance")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const mine = me?.rank === e.rank;
              return (
                <tr key={`${e.rank}-${e.name}`} className={mine ? "me" : undefined}>
                  <td>{t.num(e.rank)}</td>
                  <td>
                    {mine ? `${t.t("lb.youRow")} · ` : ""}
                    {e.name}
                    {e.hits === 0 && <span className="badge">{t.t("lb.flawless")}</span>}
                  </td>
                  <td>{t.num(e.garlic)}</td>
                  <td>{t.num(e.hits)}</td>
                  <td>{t.num(e.distanceM)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {me && !meInTop && <p className="small">{t.t("lb.you", { rank: t.num(me.rank) })}</p>}
    </Overlay>
  );
}

/** "My rewards" (RWD-06): codes claimed on this device. */
export function MyRewardsScreen({ codes, onBack }: { codes: IssuedCode[]; onBack: () => void }) {
  const { t } = useUi();
  return (
    <Overlay labelledBy="rewards-title">
      <div className="card-bar">
        <button type="button" className="linkish" onClick={onBack} data-autofocus>
          ← {t.t("common.back")}
        </button>
        <Tools />
      </div>
      <h2 id="rewards-title" className="heading">
        {t.t("myRewards.title")}
      </h2>
      {codes.length === 0 && <p className="note">{t.t("myRewards.empty")}</p>}
      {codes.map((code) => (
        <CodeCard key={code.code} code={code} />
      ))}
      {codes.length > 0 && <p className="small">{t.t("coupon.howTo")}</p>}
    </Overlay>
  );
}
