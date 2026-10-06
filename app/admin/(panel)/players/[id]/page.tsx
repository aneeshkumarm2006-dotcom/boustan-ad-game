import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { playerDetail } from "@/lib/server/admin/players";
import { formatMontreal } from "@/lib/server/admin/time";
import { db } from "@/lib/server/db";
import { ActionForm, Submit } from "../../forms";
import {
  erasePlayerAction,
  renameAction,
  resendCouponAction,
  setHiddenAction,
} from "../../actions";
import { n } from "../../format";

export const metadata = { title: "Player · Boustan game admin" };

const STATUS_TAG: Record<string, string> = {
  sent: "",
  pending: "warn",
  sending: "warn",
  retry: "warn",
  failed: "bad",
  blocked: "bad",
};

export default async function PlayerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const detail = await playerDetail(db(), id);
  if (!detail || detail.player.deletedAt) notFound();
  const { player, best } = detail;

  return (
    <>
      <div className="adm-head">
        <div>
          <p>
            <Link href="/admin/players">← Players</Link>
          </p>
          <h1>{player.email}</h1>
          <p>
            {player.nickname ?? "No nickname"} · {player.language.toUpperCase()} · joined{" "}
            {formatMontreal(player.createdAt)}
          </p>
        </div>
        <div className="adm-row">
          {player.hidden && <span className="adm-tag warn">hidden from leaderboard</span>}
          {player.marketingOptIn ? (
            <span className="adm-tag">opted in to offers</span>
          ) : (
            <span className="adm-tag mute">no marketing consent</span>
          )}
          {player.emailBlockedAt && (
            <span className="adm-tag bad">email blocked: {player.emailBlockReason}</span>
          )}
        </div>
      </div>

      <div className="adm-grid two">
        <section className="adm-card" aria-labelledby="profile-title">
          <h2 id="profile-title">Profile</h2>
          <dl className="adm-dl">
            <dt>First seen from</dt>
            <dd>{player.firstSrc ?? "—"}</dd>
            <dt>First host</dt>
            <dd>{player.firstHost ?? "—"}</dd>
            <dt>Campaign tags</dt>
            <dd>
              {Object.entries(player.utm).length > 0
                ? Object.entries(player.utm)
                    .map(([k, v]) => `${k.replace("utm_", "")}=${v}`)
                    .join(", ")
                : "—"}
            </dd>
            <dt>Confirmed 14+</dt>
            <dd>{formatMontreal(player.ageConfirmedAt)}</dd>
            <dt>Last seen</dt>
            <dd>{formatMontreal(player.lastSeenAt)}</dd>
            <dt>Devices</dt>
            <dd>{detail.devices}</dd>
            <dt>Best run</dt>
            <dd>
              {best
                ? `${n(best.garlic)} garlic · ${n(best.hits)} hits · ${n(Math.floor(best.distanceM))} m`
                : "—"}
            </dd>
          </dl>
        </section>

        <section className="adm-card" aria-labelledby="actions-title">
          <h2 id="actions-title">Actions</h2>
          <ActionForm action={resendCouponAction}>
            <input type="hidden" name="id" value={player.id} />
            <div className="adm-row">
              <Submit pending="Queuing…">Resend coupon email</Submit>
              <span className="adm-note">
                Sends all the codes this player holds to their address.
              </span>
            </div>
          </ActionForm>
          <ActionForm action={renameAction}>
            <input type="hidden" name="id" value={player.id} />
            <div className="adm-row">
              <div className="adm-field">
                <label htmlFor="name">Leaderboard name</label>
                <input
                  id="name"
                  type="text"
                  name="name"
                  defaultValue={player.nickname ?? ""}
                  maxLength={16}
                />
              </div>
              <Submit className="adm-btn ghost">Rename</Submit>
            </div>
            <small className="adm-note">Leave blank to give a new food name.</small>
          </ActionForm>
          <ActionForm action={setHiddenAction}>
            <input type="hidden" name="id" value={player.id} />
            <input type="hidden" name="hidden" value={player.hidden ? "0" : "1"} />
            <div className="adm-row">
              <Submit className="adm-btn ghost">
                {player.hidden ? "Show on leaderboard" : "Hide from leaderboard"}
              </Submit>
              <span className="adm-note">
                A hidden player stays hidden if they come back with the same email.
              </span>
            </div>
          </ActionForm>
          <div className="adm-row">
            <a className="adm-btn ghost" href={`/api/admin/players/${player.id}/export`} download>
              Export this player&rsquo;s data (JSON)
            </a>
          </div>
        </section>
      </div>

      <section className="adm-card" aria-labelledby="claims-title">
        <h2 id="claims-title">Rewards and codes</h2>
        {detail.claims.length === 0 ? (
          <p className="adm-note">No rewards claimed.</p>
        ) : (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Claimed</th>
                  <th>Reward</th>
                  <th>Code</th>
                  <th>Code status</th>
                  <th>Expires</th>
                  <th>Email</th>
                  <th>From</th>
                </tr>
              </thead>
              <tbody>
                {detail.claims.map((c) => (
                  <tr key={c.id}>
                    <td>{formatMontreal(c.createdAt)}</td>
                    <td>{c.reward}</td>
                    <td className="adm-mono">{c.code ?? "—"}</td>
                    <td>{c.codeStatus ?? "—"}</td>
                    <td>{formatMontreal(c.expiresAt)}</td>
                    <td>
                      <span className={`adm-tag ${STATUS_TAG[c.emailStatus] ?? "mute"}`}>
                        {c.emailStatus}
                      </span>
                    </td>
                    <td>{c.src ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="adm-card" aria-labelledby="runs-title">
        <header>
          <h2 id="runs-title">Runs</h2>
          <span className="adm-note">Latest 50</span>
        </header>
        {detail.runs.length === 0 ? (
          <p className="adm-note">No runs linked to this player.</p>
        ) : (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Status</th>
                  <th className="num">Distance</th>
                  <th className="num">Garlic</th>
                  <th className="num">Hits</th>
                  <th className="num">Time</th>
                  <th>From</th>
                </tr>
              </thead>
              <tbody>
                {detail.runs.map((r) => (
                  <tr key={r.id}>
                    <td>{formatMontreal(r.finishedAt)}</td>
                    <td>
                      {r.status === "valid" ? (
                        <span className="adm-tag">valid</span>
                      ) : (
                        <span className="adm-tag bad">flagged: {r.flagReason}</span>
                      )}
                    </td>
                    <td className="num">{n(Math.floor(r.distanceM))} m</td>
                    <td className="num">{n(r.garlic)}</td>
                    <td className="num">{n(r.hits)}</td>
                    <td className="num">{(r.activeMs / 1000).toFixed(1)} s</td>
                    <td>{r.src ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="adm-card" aria-labelledby="consents-title">
        <header>
          <h2 id="consents-title">Consent log</h2>
          <span className="adm-note">Append-only: what the player saw and when.</span>
        </header>
        {detail.consents.length === 0 ? (
          <p className="adm-note">No consent records.</p>
        ) : (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Kind</th>
                  <th>Decision</th>
                  <th>Source</th>
                  <th>Version</th>
                  <th>Language</th>
                  <th>IP</th>
                  <th>Text shown</th>
                </tr>
              </thead>
              <tbody>
                {detail.consents.map((c) => (
                  <tr key={c.id}>
                    <td>{formatMontreal(c.createdAt)}</td>
                    <td>{c.kind === "terms_age" ? "Terms and 14+" : "Offers by email"}</td>
                    <td>
                      <span className={`adm-tag ${c.granted ? "" : "warn"}`}>
                        {c.granted ? "granted" : "withdrawn"}
                      </span>
                    </td>
                    <td>{c.source}</td>
                    <td>{c.textVersion}</td>
                    <td>{c.language.toUpperCase()}</td>
                    <td className="adm-mono">{c.ip ?? "—"}</td>
                    <td style={{ maxWidth: 420 }}>{c.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="adm-card" aria-labelledby="emails-title">
        <h2 id="emails-title">Emails</h2>
        {detail.emails.length === 0 ? (
          <p className="adm-note">No emails queued.</p>
        ) : (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Queued</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th className="num">Attempts</th>
                  <th>Sent</th>
                  <th>Last error</th>
                </tr>
              </thead>
              <tbody>
                {detail.emails.map((e) => (
                  <tr key={e.id}>
                    <td>{formatMontreal(e.createdAt)}</td>
                    <td>{e.kind}</td>
                    <td>
                      <span className={`adm-tag ${STATUS_TAG[e.status] ?? "mute"}`}>
                        {e.status}
                      </span>
                    </td>
                    <td className="num">{e.attempts}</td>
                    <td>{formatMontreal(e.sentAt)}</td>
                    <td>{e.lastError ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section
        className="adm-card"
        aria-labelledby="erase-title"
        style={{ borderColor: "#eba39d" }}
      >
        <h2 id="erase-title">Erase this player</h2>
        <p className="adm-note">
          Removes the email, nickname, consent log (including IP addresses), device tokens and the
          leaderboard row. Runs, claims and codes stay as anonymous totals, and codes already issued
          still count against the pool. This can&rsquo;t be undone. If this player is hidden,
          erasing lifts the block: they could return as a new player.
        </p>
        <ActionForm action={erasePlayerAction}>
          <input type="hidden" name="id" value={player.id} />
          <div className="adm-row">
            <div className="adm-field">
              <label htmlFor="confirm">Type ERASE to confirm</label>
              <input id="confirm" type="text" name="confirm" autoComplete="off" />
            </div>
            <Submit className="adm-btn danger" pending="Erasing…">
              Erase personal data
            </Submit>
          </div>
        </ActionForm>
      </section>
    </>
  );
}
