import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { adminFromSession, SESSION_COOKIE } from "@/lib/server/admin/auth";
import { env } from "@/lib/server/env";
import { LoginForm } from "./LoginForm";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const jar = await cookies();
  if (adminFromSession(jar.get(SESSION_COOKIE)?.value)) redirect("/admin");
  const { error } = await searchParams;
  const e = env();
  return (
    <main className="adm-login">
      <div className="adm-card">
        <h1>Boustan game admin</h1>
        <p className="adm-note">Sauvez le poulet / Save the Chicken</p>
        {error && (
          <p className="adm-msg err" role="alert">
            That sign-in link has expired or was already replaced. Ask for a new one.
          </p>
        )}
        {!e.production && e.adminEmails.length === 0 && (
          <p className="adm-msg info">
            Setup: ADMIN_EMAILS is empty, so nobody can sign in yet. Add the allowed addresses to
            the environment.
          </p>
        )}
        <LoginForm />
      </div>
    </main>
  );
}
