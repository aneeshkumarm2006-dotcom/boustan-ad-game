"use client";

import { useActionState } from "react";
import { requestLink, type LoginState } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(requestLink, null);
  return (
    <form action={action} className="adm-form">
      <div className="adm-field">
        <label htmlFor="admin-email">Work email</label>
        <input
          id="admin-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          autoFocus
          maxLength={254}
        />
        <small>We email you a sign-in link, valid for 15 minutes.</small>
      </div>
      <button type="submit" className="adm-btn main" disabled={pending}>
        {pending ? "Sending…" : "Email me a sign-in link"}
      </button>
      {state?.status === "invalid" && (
        <p className="adm-msg err" role="alert">
          Enter a valid email address.
        </p>
      )}
      {state?.status === "limited" && (
        <p className="adm-msg err" role="alert">
          Too many attempts. Try again in a while.
        </p>
      )}
      {state?.status === "sent" && (
        <div className="adm-msg ok" role="status">
          If that address can sign in, a link is on its way.
          {state.devLink && (
            <p style={{ marginTop: 8 }}>
              Demo mode: <a href={state.devLink}>open the sign-in link</a>
            </p>
          )}
        </div>
      )}
    </form>
  );
}
