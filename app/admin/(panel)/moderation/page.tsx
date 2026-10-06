import Link from "next/link";
import { boardForModeration, flagSummary, flaggedRuns } from "@/lib/server/admin/moderation";
import { formatMontreal } from "@/lib/server/admin/time";
import { db } from "@/lib/server/db";
import { ActionForm, Submit } from "../forms";
import { renameAction, setHiddenAction } from "../actions";
import { n } from "../format";

export const metadata = { title: "Moderation · Boustan game admin" };

const REASONS: Record<string, string> = {
  distance: "Distance doesn't match the time played",
  too_fast: "Claims more play time than the clock allows",
  garlic: "More garlic than the level had",
  hits: "More hits than the level had",
  expired: "Run token expired (over 2 hours)",
  version: "Game version changed mid-run",
  bad_input: "Impossible numbers",
};

export default async function ModerationPage() {
  const [board, flagged, summary] = await Promise.all([
    boardForModeration(db()),
    flaggedRuns(db()),
    flagSummary(db()),
  ]);

  return (
    <>
      <div className="adm-head">
        <div>
          <h1>Moderation</h1>
          <p>
            Hide an entry or rename it, and review the runs the game flagged. Players see only
            nicknames on the public leaderboard, never emails.
          </p>
        </div>
      </div>

      <section className="adm-card" aria-labelledby="board-title">
        <header>
          <h2 id="board-title">Leaderboard</h2>
          <span className="adm-note">Top 200 as admins see it, hidden entries included.</span>
        </header>
        {board.length === 0 ? (
          <p className="adm-note">Nobody is on the leaderboard yet.</p>
        ) : (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th className="num">Rank</th>
                  <th>Name</th>
                  <th>Player</th>
                  <th className="num">Garlic</th>
                  <th className="num">Hits</th>
                  <th className="num">Distance</th>
                  <th>Rename</th>
                  <th>Visibility</th>
                </tr>
              </thead>
              <tbody>
                {board.map((e) => (
                  <tr key={e.playerId} className={e.hidden ? "dim" : undefined}>
                    <td className="num">{e.rank ?? "—"}</td>
                    <td>
                      <b>{e.nickname ?? "—"}</b>{" "}
                      {e.hidden && <span className="adm-tag warn">hidden</span>}
                    </td>
                    <td>
                      <Link href={`/admin/players/${e.playerId}`}>{e.email}</Link>
                    </td>
                    <td className="num">{n(e.garlic)}</td>
                    <td className="num">{n(e.hits)}</td>
                    <td className="num">{n(Math.floor(e.distanceM))} m</td>
                    <td>
                      <ActionForm action={renameAction} className="adm-row">
                        <input type="hidden" name="id" value={e.playerId} />
                        <label className="adm-label" htmlFor={`rn-${e.playerId}`} hidden>
                          New name for {e.nickname}
                        </label>
                        <input
                          id={`rn-${e.playerId}`}
                          type="text"
                          name="name"
                          maxLength={16}
                          placeholder="New name"
                          style={{ width: 130 }}
                        />
                        <Submit className="adm-btn ghost small">Rename</Submit>
                      </ActionForm>
                    </td>
                    <td>
                      <ActionForm action={setHiddenAction} className="adm-row">
                        <input type="hidden" name="id" value={e.playerId} />
                        <input type="hidden" name="hidden" value={e.hidden ? "0" : "1"} />
                        <Submit className={`adm-btn small ${e.hidden ? "ghost" : "danger"}`}>
                          {e.hidden ? "Show" : "Hide"}
                        </Submit>
                      </ActionForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="adm-card" aria-labelledby="flagged-title">
        <header>
          <h2 id="flagged-title">Flagged runs</h2>
          <span className="adm-note">
            Runs that failed the server&rsquo;s checks. They earn no reward and never reach the
            leaderboard.
          </span>
        </header>
        {summary.length > 0 && (
          <div className="adm-row">
            {summary.map((s) => (
              <span key={s.reason} className="adm-tag warn">
                {s.reason}: {n(s.n)} in 7 days
              </span>
            ))}
          </div>
        )}
        {flagged.length === 0 ? (
          <p className="adm-note">No flagged runs.</p>
        ) : (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Why</th>
                  <th className="num">Distance</th>
                  <th className="num">Garlic</th>
                  <th className="num">Hits</th>
                  <th className="num">Time</th>
                  <th>From</th>
                  <th>Build</th>
                  <th>Player</th>
                </tr>
              </thead>
              <tbody>
                {flagged.map((r) => (
                  <tr key={r.id}>
                    <td>{formatMontreal(r.finishedAt)}</td>
                    <td>
                      <span className="adm-tag bad">{r.reason ?? "unknown"}</span>
                      <div className="adm-note">{REASONS[r.reason ?? ""] ?? ""}</div>
                    </td>
                    <td className="num">{n(Math.floor(r.distanceM))} m</td>
                    <td className="num">{n(r.garlic)}</td>
                    <td className="num">{n(r.hits)}</td>
                    <td className="num">{(r.activeMs / 1000).toFixed(1)} s</td>
                    <td>{r.src ?? r.hostOrigin ?? "—"}</td>
                    <td className="adm-mono">{r.clientVersion ?? "—"}</td>
                    <td>
                      {r.playerId ? (
                        <Link href={`/admin/players/${r.playerId}`}>view</Link>
                      ) : (
                        "anonymous"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="adm-note">
          A few flags are normal (a phone that sleeps mid-run, an old tab left open across a
          release). A burst from one placement or one build is worth a closer look.
        </p>
      </section>
    </>
  );
}
