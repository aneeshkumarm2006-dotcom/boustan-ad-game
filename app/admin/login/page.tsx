import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { adminFromSession, SESSION_COOKIE } from "@/lib/server/admin/auth";
import { env } from "@/lib/server/env";
import { Wordmark } from "../Wordmark";
import { LoginForm } from "./LoginForm";

export default async function LoginPage() {
  const jar = await cookies();
  if (adminFromSession(jar.get(SESSION_COOKIE)?.value)) redirect("/admin");
  return (
    <main className="adm-login">
      <Wordmark className="adm-login-mark" />
      <div className="adm-card">
        <h1>Boustan game admin</h1>
        <p className="adm-note">Sauvez le poulet / Save the Chicken</p>
        {!env().production && !env().ADMIN_PASSWORD && (
          <p className="adm-msg info">
            Setup: ADMIN_PASSWORD is empty, so nobody can sign in yet. Set it in the environment.
          </p>
        )}
        <LoginForm />
      </div>
    </main>
  );
}
