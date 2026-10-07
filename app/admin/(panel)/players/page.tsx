import Link from "next/link";
import { searchPlayers } from "@/lib/server/admin/players";
import { formatMontreal } from "@/lib/server/admin/time";
import { db } from "@/lib/server/db";
import { n } from "../format";

export const metadata = { title: "Players · Boustan game admin" };

export default async function PlayersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; erased?: string }>;
}) {
  const { q = "", erased } = await searchParams;
  const rows = await searchPlayers(db(), q);

  return (
    <>
      <div className="adm-head">
        <div>
          <h1>Players</h1>
          <p>
            Everyone who saved a score. Open a player to see their runs and consents, export or
            erase their data.
          </p>
        </div>
      </div>

      {erased && (
        <p className="adm-msg ok" role="status">
          The player&rsquo;s personal data was erased. Anonymous totals are kept.
        </p>
      )}

      <section className="adm-card" aria-labelledby="search-title">
        <h2 id="search-title">Find a player</h2>
        <form method="get" className="adm-row">
          <div className="adm-field" style={{ flex: 1, minWidth: 240 }}>
            <label htmlFor="q">Email or nickname</label>
            <input id="q" type="search" name="q" defaultValue={q} maxLength={100} autoFocus />
          </div>
          <button type="submit" className="adm-btn">
            Search
          </button>
          {q && (
            <Link href="/admin/players" className="adm-btn ghost">
              Clear
            </Link>
          )}
        </form>
        {rows.length === 0 ? (
          <p className="adm-note">{q ? "No player matches that." : "No players yet."}</p>
        ) : (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Nickname</th>
                  <th>Language</th>
                  <th className="num">Best (points)</th>
                  <th>Offers</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link href={`/admin/players/${p.id}`}>{p.email}</Link>
                    </td>
                    <td>
                      {p.nickname ?? "—"} {p.hidden && <span className="adm-tag warn">hidden</span>}
                    </td>
                    <td>{p.language.toUpperCase()}</td>
                    <td className="num">{p.bestPoints === null ? "—" : n(p.bestPoints)}</td>
                    <td>
                      {p.marketingOptIn ? (
                        <span className="adm-tag">opted in</span>
                      ) : (
                        <span className="adm-tag mute">no</span>
                      )}
                    </td>
                    <td>{formatMontreal(p.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="adm-note">
          {q ? "Showing up to 50 matches." : "Showing the 50 newest players."}
        </p>
      </section>

      <section className="adm-card" aria-labelledby="export-title">
        <h2 id="export-title">Export players</h2>
        <p className="adm-note">
          One row per player on the leaderboard, in rank order: rank, email, nickname, points,
          distance and garlic, language, every consent field (text shown, version, date, source,
          IP), placement and dates. Each download is logged.
        </p>
        <div className="adm-row">
          <a className="adm-btn" href="/api/admin/export/players" download>
            Download all players (CSV)
          </a>
          <a className="adm-btn ghost" href="/api/admin/export/players?winners=1" download>
            Download winners (CSV)
          </a>
          <a className="adm-btn ghost" href="/api/admin/export/players?optedIn=1" download>
            Only those who opted in to offers (CSV)
          </a>
        </div>
      </section>
    </>
  );
}
