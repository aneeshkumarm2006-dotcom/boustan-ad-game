import Link from "next/link";
import { WINNERS } from "@/game-core";
import { montrealDay } from "@/lib/server/analytics";
import {
  FUNNEL_STEPS,
  SPLITS,
  emptyFunnel,
  funnel,
  health,
  refreshRollup,
  sumFunnel,
  type Split,
} from "@/lib/server/admin/dashboard";
import { loadSettings } from "@/lib/server/admin/settings";
import { db } from "@/lib/server/db";
import { topEntries } from "@/lib/server/leaderboard";
import { winnersTitle } from "./contest";
import { n, pct } from "./format";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SPLIT_LABEL: Record<Split, string> = {
  day: "Day",
  src: "Placement",
  lang: "Language",
  device: "Device",
};

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; split?: string }>;
}) {
  const q = await searchParams;
  const to = q.to && DAY.test(q.to) ? q.to : montrealDay(0);
  const from = q.from && DAY.test(q.from) ? q.from : montrealDay(13);
  const split = SPLITS.includes(q.split as Split) ? (q.split as Split) : "day";

  await refreshRollup(db());
  const [daily, rows, h, top, settings] = await Promise.all([
    funnel(db(), from, to, "day"),
    split === "day" ? null : funnel(db(), from, to, split),
    health(db()),
    topEntries(db(), WINNERS),
    loadSettings(db()),
  ]);
  const total = daily.length > 0 ? sumFunnel(daily) : emptyFunnel();
  const table = rows ?? daily;
  const href = (s: Split) => `/admin?from=${from}&to=${to}&split=${s}`;

  return (
    <>
      <div className="adm-head">
        <div>
          <h1>Dashboard</h1>
          <p>
            How the contest is doing, from the first load to a saved score. Days are Montréal time.
            Numbers refresh every minute.
          </p>
        </div>
        <form method="get" className="adm-row">
          <div className="adm-field">
            <label htmlFor="from">From</label>
            <input id="from" type="date" name="from" defaultValue={from} />
          </div>
          <div className="adm-field">
            <label htmlFor="to">To</label>
            <input id="to" type="date" name="to" defaultValue={to} />
          </div>
          <input type="hidden" name="split" value={split} />
          <button type="submit" className="adm-btn">
            Show
          </button>
        </form>
      </div>

      <section className="adm-grid" aria-label="Right now">
        <div className="adm-stat">
          <b>{n(h.players)}</b>
          <span>Players on the leaderboard ({pct(h.optedIn, h.players)} opted in to offers)</span>
        </div>
        <div className="adm-stat">
          <b>{n(h.runs24h)}</b>
          <span>Runs in the last 24 hours</span>
        </div>
        <Link
          href="/admin/leaderboard#flagged"
          className={`adm-stat${h.flaggedRuns24h > 0 ? " warn" : ""}`}
          style={{ textDecoration: "none", color: "inherit" }}
        >
          <b>{n(h.flaggedRuns24h)}</b>
          <span>Flagged runs in the last 24 hours</span>
        </Link>
        <div className="adm-stat">
          <b>{n(h.savedToday)}</b>
          <span>Scores saved today</span>
        </div>
        <div className="adm-stat">
          <b>
            {h.top ? n(h.top.points) : "—"}{" "}
            {h.top && <small style={{ fontSize: 14, fontWeight: 400 }}>points</small>}
          </b>
          <span>{h.top ? `Top score, by ${h.top.nickname ?? "—"}` : "Top score: nobody yet"}</span>
        </div>
      </section>

      <section className="adm-card" aria-labelledby="winners-title">
        <header>
          <h2 id="winners-title">{winnersTitle(settings, new Date())}</h2>
          <Link href="/admin/leaderboard">Open the leaderboard</Link>
        </header>
        {top.length === 0 ? (
          <p className="adm-note">Nobody is on the leaderboard yet.</p>
        ) : (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th className="num">Rank</th>
                  <th>Nickname</th>
                  <th className="num">Points</th>
                </tr>
              </thead>
              <tbody>
                {top.map((e) => (
                  <tr key={e.rank}>
                    <td className="num">{e.rank}</td>
                    <td>{e.name}</td>
                    <td className="num">{n(e.points)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="adm-card" aria-labelledby="funnel-title">
        <header>
          <h2 id="funnel-title">Funnel</h2>
          <span className="adm-note">
            {from} to {to}
          </span>
        </header>
        <div className="adm-funnel">
          {FUNNEL_STEPS.map((step, i) => {
            const value = total[step.key];
            // Each step is shown against the one that really feeds it: starts against loads, the rest
            // against runs started (a player can reach the save form without a fresh start).
            const feeder = i === 0 ? null : i === 1 ? total.loads : total.starts;
            const base = total.loads || total.starts || 1;
            return (
              <div className="adm-funnel-row" key={step.key}>
                <span>{step.label}</span>
                <div className="adm-bar" role="img" aria-label={`${n(value)} ${step.label}`}>
                  <i style={{ width: `${Math.min(100, (value / base) * 100)}%` }} />
                </div>
                <small>
                  <b>{n(value)}</b>
                  {feeder !== null && ` · ${pct(value, feeder)} of ${i === 1 ? "loads" : "runs"}`}
                </small>
              </div>
            );
          })}
        </div>
        <p className="adm-note">
          Loads are distinct visits per day; the other steps count events, so one visitor can add
          several runs. Percentages for the steps after Runs started are shares of runs. Returning
          players are saved automatically when a run ends, so only new players open the save form.
        </p>
      </section>

      <section className="adm-card" aria-labelledby="split-title">
        <header>
          <h2 id="split-title">Split by</h2>
          <div className="adm-split">
            {SPLITS.map((s) => (
              <Link key={s} href={href(s)} aria-current={s === split ? "true" : undefined}>
                {SPLIT_LABEL[s]}
              </Link>
            ))}
          </div>
        </header>
        {table.length === 0 ? (
          <p className="adm-note">No activity in this period yet.</p>
        ) : (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>{SPLIT_LABEL[split]}</th>
                  {FUNNEL_STEPS.map((s) => (
                    <th key={s.key} className="num">
                      {s.label}
                    </th>
                  ))}
                  <th className="num">Save rate</th>
                </tr>
              </thead>
              <tbody>
                {table.map((r) => (
                  <tr key={r.key} className={r.key === "" ? "dim" : undefined}>
                    <td>{r.key === "" ? "(none)" : r.key}</td>
                    {FUNNEL_STEPS.map((s) => (
                      <td key={s.key} className="num">
                        {n(r[s.key])}
                      </td>
                    ))}
                    <td className="num">{pct(r.saves, r.starts, 1)}</td>
                  </tr>
                ))}
                {split !== "day" || table.length > 1 ? (
                  <tr className="total">
                    <td>Total</td>
                    {FUNNEL_STEPS.map((s) => (
                      <td key={s.key} className="num">
                        {n(total[s.key])}
                      </td>
                    ))}
                    <td className="num">{pct(total.saves, total.starts, 1)}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
        <p className="adm-note">Save rate is saved scores as a share of runs started.</p>
      </section>
    </>
  );
}
