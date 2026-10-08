"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { NAME_MAX, looksLikeEmail } from "@/lib/email";
import { nicknameProblem, type NicknameProblem } from "@/lib/nicknames";
import { useUi } from "./context";
import { RichText } from "./parts";
import { TURNSTILE_ENABLED, useTurnstile } from "./turnstile";

export interface SaveInput {
  email: string;
  nickname: string;
  termsAge: boolean;
  marketingOptIn: boolean;
  turnstileToken: string;
}

export type SaveErrorKey =
  | "save.errors.network"
  | "save.errors.expired"
  | "save.errors.rejected"
  | "save.errors.badEmail"
  | "save.errors.tooMany"
  | "save.errors.closed";

export type SaveSubmit = (input: SaveInput) => Promise<SaveErrorKey | null>;

/** Name and email score form displayed directly after a completed run. */
export function SaveScreen({ points, onSubmit }: { points: number; onSubmit: SaveSubmit }) {
  const { t, lang, emit } = useUi();
  useEffect(() => {
    emit({ type: "save_view" });
  }, [emit]);
  const id = useId();
  // Loads only now that the form is open (EMB-11), so a token is usually ready by submit.
  const turnstileBox = useRef<HTMLDivElement>(null);
  const turnstile = useTurnstile(turnstileBox, lang);
  const [email, setEmail] = useState("");
  const [nickname, setNickname] = useState("");
  const [termsAge, setTermsAge] = useState(false);
  const [optIn, setOptIn] = useState(false);
  const [errors, setErrors] = useState<{
    email?: boolean;
    nickname?: NicknameProblem;
    terms?: boolean;
  }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function send(input: Omit<SaveInput, "turnstileToken">) {
    setSending(true);
    setFailure(null);
    const turnstileToken = await turnstile.getToken();
    const error = await onSubmit({ ...input, turnstileToken });
    turnstile.reset();
    setSending(false);
    if (error) setFailure(t.t(error));
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (sending) return;
    const next = {
      email: !looksLikeEmail(email),
      nickname: nicknameProblem(nickname) ?? undefined,
      terms: !termsAge,
    };
    setErrors(next);
    if (next.email || next.nickname || next.terms) {
      const first = next.email ? "email" : next.nickname ? "nickname" : "terms";
      document.getElementById(`${id}-${first}`)?.focus();
      return;
    }
    void send({
      email: email.trim(),
      nickname: nickname.trim(),
      termsAge,
      marketingOptIn: optIn,
    });
  }

  const errorId = (field: string) => `${id}-${field}-error`;
  return (
    <section aria-labelledby={`${id}-title`} className="save-next">
      <h2 id={`${id}-title`} className="heading">
        {t.t("save.title")}
      </h2>
      <p className="sub">{t.plural("save.lede", points, { points: t.num(points) })}</p>
      <form onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={`${id}-email`}>{t.t("save.email")}</label>
          <input
            id={`${id}-email`}
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={errors.email || undefined}
            aria-describedby={errors.email ? errorId("email") : `${id}-email-hint`}
            data-autofocus
          />
          {errors.email ? (
            <p id={errorId("email")} className="error">
              {t.t("save.errors.email")}
            </p>
          ) : (
            <p id={`${id}-email-hint`} className="small">
              {t.t("save.emailHint")}
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor={`${id}-nickname`}>{t.t("save.nickname")}</label>
          <input
            id={`${id}-nickname`}
            type="text"
            autoComplete="name"
            required
            maxLength={NAME_MAX}
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            aria-invalid={errors.nickname ? true : undefined}
            aria-describedby={errors.nickname ? errorId("nickname") : `${id}-nickname-hint`}
          />
          {errors.nickname ? (
            <p id={errorId("nickname")} className="error">
              {t.t(
                errors.nickname === "missing"
                  ? "save.errors.nicknameMissing"
                  : errors.nickname === "rude"
                    ? "save.errors.nicknameRude"
                    : "save.errors.nickname",
              )}
            </p>
          ) : (
            <p id={`${id}-nickname-hint`} className="small">
              {t.t("save.nicknameHint")}
            </p>
          )}
        </div>
        <label className="check-row">
          <input
            id={`${id}-terms`}
            type="checkbox"
            required
            checked={termsAge}
            onChange={(e) => setTermsAge(e.target.checked)}
            aria-invalid={errors.terms || undefined}
            aria-describedby={errors.terms ? errorId("terms") : undefined}
          />
          <span>
            <RichText text={t.t("consent.terms")} links={{ terms: "terms", privacy: "privacy" }} />
          </span>
        </label>
        {errors.terms && (
          <p id={errorId("terms")} className="error">
            {t.t("save.errors.terms")}
          </p>
        )}
        <label className="check-row">
          <input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} />
          <span>{t.t("consent.marketing")}</span>
        </label>
        <button type="submit" className="btn primary big" data-testid="save" disabled={sending}>
          {sending ? t.t("save.sending") : t.t("save.cta")}
        </button>
        <p className="privacy">
          <RichText
            text={t.t("save.privacy")}
            links={{ policy: "privacy", officer: "privacyOfficer" }}
          />
        </p>
      </form>
      {failure && (
        <p className="error" role="alert">
          {failure}
        </p>
      )}
      {TURNSTILE_ENABLED && <div ref={turnstileBox} className="turnstile" />}
    </section>
  );
}
