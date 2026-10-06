import Link from "next/link";
import { recentAudit } from "@/lib/server/admin/dashboard";
import { formatMontreal } from "@/lib/server/admin/time";
import { db } from "@/lib/server/db";

export const metadata = { title: "Audit log · Boustan game admin" };

const PAGE = 50;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const page = Math.max(1, Math.min(10_000, Number((await searchParams).page) || 1));
  const rows = await recentAudit(db(), PAGE + 1, (page - 1) * PAGE);
  const more = rows.length > PAGE;
  const shown = rows.slice(0, PAGE);

  return (
    <>
      <div className="adm-head">
        <div>
          <h1>Audit log</h1>
          <p>
            Every change made from this admin, and who made it. Entries can&rsquo;t be edited or
            removed here. Player emails are never written to the log.
          </p>
        </div>
      </div>
      <section className="adm-card">
        {shown.length === 0 ? (
          <p className="adm-note">Nothing logged yet.</p>
        ) : (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Action</th>
                  <th>Target</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id}>
                    <td>{formatMontreal(r.createdAt)}</td>
                    <td>{r.adminEmail}</td>
                    <td className="adm-mono">{r.action}</td>
                    <td className="adm-mono">{r.target ?? "—"}</td>
                    <td className="adm-mono" style={{ maxWidth: 420, overflowWrap: "anywhere" }}>
                      {Object.keys(r.details).length > 0 ? JSON.stringify(r.details) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="adm-row">
          {page > 1 && (
            <Link className="adm-btn ghost" href={`/admin/audit?page=${page - 1}`}>
              ← Newer
            </Link>
          )}
          {more && (
            <Link className="adm-btn ghost" href={`/admin/audit?page=${page + 1}`}>
              Older →
            </Link>
          )}
        </div>
      </section>
    </>
  );
}
