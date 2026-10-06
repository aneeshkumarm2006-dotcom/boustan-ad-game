import { recentBatches, poolStats } from "@/lib/server/admin/pools";
import { percentLeft, recipients } from "@/lib/server/admin/stock-alerts";
import { formatMontreal } from "@/lib/server/admin/time";
import { db } from "@/lib/server/db";
import { ActionForm, Submit } from "../forms";
import { importCodesAction, redeemedReportAction, saveAlertsAction } from "../actions";
import { n, pct } from "../format";

export const metadata = { title: "Code pools · Boustan game admin" };

export default async function CodesPage() {
  const [pools, batches, to] = await Promise.all([
    poolStats(db()),
    recentBatches(db()),
    recipients(db()),
  ]);
  const name = (id: string) => pools.find((p) => p.reward === id)?.names.en ?? id;

  return (
    <>
      <div className="adm-head">
        <div>
          <h1>Code pools</h1>
          <p>
            Each reward has its own pool of single-use uEat codes. The size of the pool is the
            budget: when it runs out, the reward shows &ldquo;All gone&rdquo; and nobody can claim
            it.
          </p>
        </div>
      </div>

      <section className="adm-grid two" aria-label="Pools">
        {pools.map((p) => {
          const base = p.total - p.void;
          const left = percentLeft(p);
          return (
            <article key={p.reward} className="adm-card">
              <header>
                <h2>
                  {p.names.en} / {p.names.fr}
                </h2>
                <span className={`adm-tag ${p.active ? "" : "warn"}`}>
                  {p.active ? "active" : "paused"}
                </span>
              </header>
              <div className="adm-table-wrap">
                <table className="adm-table">
                  <tbody>
                    <tr>
                      <th scope="row">Available</th>
                      <td className="num">
                        <b>{n(p.available)}</b> ({pct(p.available, base)} of the pool)
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">Issued, not yet redeemed</th>
                      <td className="num">{n(p.assigned)}</td>
                    </tr>
                    <tr>
                      <th scope="row">Redeemed</th>
                      <td className="num">
                        {n(p.redeemed)}
                        {p.redemptionRate !== null &&
                          ` (${pct(p.redeemed, p.assigned + p.redeemed)} of issued)`}
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">Expired, never issued</th>
                      <td className="num">{n(p.expiredAvailable)}</td>
                    </tr>
                    <tr>
                      <th scope="row">Voided</th>
                      <td className="num">{n(p.void)}</td>
                    </tr>
                    <tr className="total">
                      <th scope="row">Total imported</th>
                      <td className="num">{n(p.total)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {base > 0 && left <= Math.max(...p.alertThresholds) && (
                <p className="adm-msg info">
                  Running low: {n(p.available)} left. Alerts go out at{" "}
                  {p.alertThresholds.map((t) => `${t}%`).join(" and ")}.
                </p>
              )}

              <ActionForm action={importCodesAction}>
                <input type="hidden" name="reward" value={p.reward} />
                <h3>Add codes</h3>
                <div className="adm-field">
                  <label htmlFor={`file-${p.reward}`}>CSV file</label>
                  <input
                    id={`file-${p.reward}`}
                    type="file"
                    name="file"
                    accept=".csv,text/csv,.txt"
                    required
                  />
                  <small>
                    A <span className="adm-mono">code</span> column is required;{" "}
                    <span className="adm-mono">expires_at</span> (YYYY-MM-DD) and{" "}
                    <span className="adm-mono">batch</span> are optional. A plain list of codes, one
                    per line, also works. Codes already in any pool are skipped.
                  </small>
                </div>
                <div className="adm-field">
                  <label htmlFor={`batch-${p.reward}`}>Batch name (optional)</label>
                  <input id={`batch-${p.reward}`} type="text" name="batch" maxLength={80} />
                </div>
                <div>
                  <Submit pending="Importing…">Import codes</Submit>
                </div>
              </ActionForm>
            </article>
          );
        })}
      </section>

      <section className="adm-card" aria-labelledby="alerts-title">
        <header>
          <h2 id="alerts-title">Low-stock alerts</h2>
          <span className="adm-note">Checked every hour. Each level sends once.</span>
        </header>
        <ActionForm action={saveAlertsAction}>
          <div className="adm-grid two">
            {pools.map((p) => (
              <div className="adm-field" key={p.reward}>
                <label htmlFor={`thr-${p.reward}`}>
                  {name(p.reward)}: alert at (% of the pool left)
                </label>
                <input
                  id={`thr-${p.reward}`}
                  type="text"
                  name={`thresholds_${p.reward}`}
                  defaultValue={p.alertThresholds.join(", ")}
                  inputMode="numeric"
                  required
                />
                <small>
                  {p.alertLevel !== null
                    ? `Last alert sent at ${p.alertLevel}%. Adding codes re-arms it.`
                    : "No alert sent yet."}
                </small>
              </div>
            ))}
          </div>
          <div className="adm-field">
            <label htmlFor="alert-emails">Send alerts to</label>
            <input
              id="alert-emails"
              type="text"
              name="emails"
              defaultValue={to.join(", ")}
              placeholder="name@boustan.ca, other@boustan.ca"
            />
            <small>Separate addresses with commas. Blank uses the admin sign-in addresses.</small>
          </div>
          <div>
            <Submit>Save alert settings</Submit>
          </div>
        </ActionForm>
      </section>

      <section className="adm-card" aria-labelledby="redeemed-title">
        <header>
          <h2 id="redeemed-title">uEat redeemed-codes report</h2>
          <span className="adm-note">Optional</span>
        </header>
        <p className="adm-note">
          Upload the report of codes used at the till to mark them as redeemed and see the
          redemption rate. It needs a <span className="adm-mono">code</span> column; a{" "}
          <span className="adm-mono">redeemed_at</span> column is used when present.
        </p>
        <ActionForm action={redeemedReportAction}>
          <div className="adm-row">
            <div className="adm-field">
              <label htmlFor="report-file">CSV file</label>
              <input
                id="report-file"
                type="file"
                name="file"
                accept=".csv,text/csv,.txt"
                required
              />
            </div>
            <Submit pending="Reading…">Mark as redeemed</Submit>
          </div>
        </ActionForm>
      </section>

      <section className="adm-card" aria-labelledby="batches-title">
        <header>
          <h2 id="batches-title">Recent imports</h2>
        </header>
        {batches.length === 0 ? (
          <p className="adm-note">No codes imported yet.</p>
        ) : (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Added</th>
                  <th>Reward</th>
                  <th>Batch</th>
                  <th className="num">Codes</th>
                  <th className="num">Still available</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={`${b.reward}-${b.batch}`}>
                    <td>{formatMontreal(b.addedAt)}</td>
                    <td>{name(b.reward)}</td>
                    <td className="adm-mono">{b.batch}</td>
                    <td className="num">{n(b.codes)}</td>
                    <td className="num">{n(b.available)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
