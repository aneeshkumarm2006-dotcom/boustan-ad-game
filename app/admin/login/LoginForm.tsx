"use client";

import { useActionState } from "react";
import { signIn, type LoginState } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(signIn, null);
  return (
    <form action={action} className="adm-form">
      <div className="adm-field">
        <label htmlFor="admin-password">Password</label>
        <input
          id="admin-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          autoFocus
          maxLength={200}
        />
      </div>
      <button type="submit" className="adm-btn main" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
      {state?.status === "wrong" && (
        <p className="adm-msg err" role="alert">
          Wrong password.
        </p>
      )}
      {state?.status === "rate_limited" && (
        <p className="adm-msg err" role="alert">
          Too many attempts. Try again in a while.
        </p>
      )}
      {state?.status === "not_configured" && (
        <p className="adm-msg err" role="alert">
          Sign-in is not set up: ADMIN_PASSWORD is empty.
        </p>
      )}
    </form>
  );
}
