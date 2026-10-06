import Link from "next/link";
import { requireAdmin } from "@/lib/server/admin/auth";
import { Wordmark } from "../Wordmark";
import { AdminNav } from "./forms";
import { signOut } from "./actions";

/** Everything under /admin except the login page: needs a session, shows the nav. */
export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const email = await requireAdmin();
  return (
    <>
      <header className="adm-top">
        <div className="adm-top-inner">
          <Link href="/admin" className="adm-brand">
            <Wordmark />
          </Link>
          <AdminNav />
          <div className="adm-who">
            <span>{email}</span>
            <form action={signOut}>
              <button type="submit" className="adm-btn ghost small">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="adm-main">{children}</main>
    </>
  );
}
