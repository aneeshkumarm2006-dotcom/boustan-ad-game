import Link from "next/link";
import { isWinningRank } from "@/game-core";
import {
  boardForModeration,
  flagSummary,
  flaggedRuns,
  winners,
  type Winner,
} from "@/lib/server/admin/moderation";
import { loadSettings } from "@/lib/server/admin/settings";
import { formatMontreal } from "@/lib/server/admin/time";
import { db } from "@/lib/server/db";
import { ActionForm, Submit } from "../forms";
import { renameAction, setHiddenAction } from "../actions";
import { ContestTags, winnersTitle } from "../contest";
import { n } from "../format";

export const metadata = { title: "Leaderboard · Boustan game admin" };

const REASONS: Record<string, string> = {
  distance: "Distance doesn't match the time played",
  too_fast: "Claims more play time than the clock allows",
  garlic: "More garlic than the level had",
  hits: "More hits than the level had",
  expired: "Run token expired (over 2 hours)",
  version: "Game version changed mid-run",
  bad_input: "Impossible numbers",
};

/** How the winning run went, from its own row, next to what the level put out. */
function runCheck(w: Winner): string {
  if (w.activeMs === null || w.hits === null || w.garlicAppeared === null) {
    return "Run details not found.";
  }
  return (
    `Played ${(w.activeMs / 1000).toFixed(1)} s · ${n(w.hits)} ${w.hits === 1 ? "hit" : "hits"}` +
    ` · garlic ${n(w.garlic)} of ${n(w.garlicAppeared)} that appeared`
  );
}

export default async function LeaderboardPage() {
  const [top, board, flagged, summary, settings] = await Promise.all([
    winners(db()),
    boardForModeration(db()),
    flaggedRuns(db()),
    flagSummary(db()),
    loadSettings(db()),
  ]);
  const now = new Date();

  return (
    <>
      <div className="adm-head">
        <div>
          <h1>Leaderboard</h1>
          <p>
            Who is winning and how to reach them, the whole board (hide or rename an entry), and the
            runs the game flagged. Players see only nicknames on the public leaderboard, never
            emails.
          </p>
        </div>
      </div>

      <section className="adm-card" aria-labelledby="winners-title">
        <header>
          <h2 id="winners-title">{winnersTitle(settings, now)}</h2>
          <div className="adm-row">
            <ContestTags contest={settings} now={now} />
            {settings.endsAt && (
              <span className="adm-note">
                Final on {formatMontreal(settings.endsAt)} (Montréal time)
              </span>
            )}
          </div>
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
                  <th>Email</th>
                  <th className="num">Points</th>
                  <th>Made of</th>
                  <th>Language</th>
                  <th>Achieved</th>
                  <th>Offers</th>
                  <th>Run check</th>
                </tr>
              </thead>
              <tbody>
                {top.map((w) => (
                  <tr key={w.playerId}>
                    <td className="num">{w.rank}</td>
                    <td>
                      <b>{w.nickname ?? "—"}</b>
                    </td>
                    <td>
                      <Link href={`/admin/players/${w.playerId}`}>{w.email}</Link>
                    </td>
                    <td className="num">{n(w.points)}</td>
                    <td>
                      {n(Math.floor(w.distanceM))} m + {n(w.garlic)} garlic
                    </td>
                    <td>{w.language.toUpperCase()}</td>
                    <td>{formatMontreal(w.achievedAt)}</td>
                    <td>
                      {w.marketingOptIn ? (
                        <span className="adm-tag">opted in</span>
                      ) : (
                        <span className="adm-tag mute">no</span>
                      )}
                    </td>
                    <td className="adm-note">{runCheck(w)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="adm-note">
          The run check sets each winning run against the level it was played on. People miss some
          garlic, so taking every garlic that appeared over a long run is a sign of a bot. Hiding a
          player (in the full leaderboard below, or on their page) removes them from the winners:
          the next player moves up.
        </p>
        <div className="adm-row">
          <a className="adm-btn" href="/api/admin/export/players?winners=1" download>
            Download winners (CSV)
          </a>
          <a className="adm-btn ghost" href="/api/admin/export/players" download>
            Download all players (CSV)
          </a>
          <a className="adm-btn ghost" href="/api/admin/export/players?optedIn=1" download>
            Only those who opted in to offers (CSV)
          </a>
        </div>
        <p className="adm-note">
          One row per player on the board, in rank order: email, nickname, points, every consent
          field, placement and dates. Each download is logged.
        </p>
      </section>

      <section className="adm-card" aria-labelledby="board-title">
        <header>
          <h2 id="board-title">Full leaderboard</h2>
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
                  <th className="num">Points</th>
                  <th className="num">Distance</th>
                  <th className="num">Garlic</th>
                  <th>Achieved</th>
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
                      {e.rank !== null && isWinningRank(e.rank) && (
                        <span className="adm-tag">winner</span>
                      )}
                      {e.hidden && <span className="adm-tag warn">hidden</span>}
                    </td>
                    <td>
                      <Link href={`/admin/players/${e.playerId}`}>{e.email}</Link>
                    </td>
                    <td className="num">{n(e.points)}</td>
                    <td className="num">{n(Math.floor(e.distanceM))} m</td>
                    <td className="num">{n(e.garlic)}</td>
                    <td>{formatMontreal(e.achievedAt)}</td>
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

      <section className="adm-card" id="flagged" aria-labelledby="flagged-title">
        <header>
          <h2 id="flagged-title">Flagged runs</h2>
          <span className="adm-note">
            Runs that failed the server&rsquo;s checks. They earn 0 points and never reach the
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
                  <th className="num">Claimed distance</th>
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
