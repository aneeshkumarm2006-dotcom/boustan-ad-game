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

/** Player details collected before the first run. */
export function EntryForm({ onSubmit, disabled }: { onSubmit: SaveSubmit; disabled: boolean }) {
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
        {t.t("start.entryTitle")}
      </h2>
      <p className="sub">{t.t("start.entryHint")}</p>
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
            onChange={(e) => {
              setEmail(e.target.value);
              setErrors((v) => ({ ...v, email: false }));
            }}
            aria-invalid={errors.email || undefined}
            aria-describedby={errors.email ? errorId("email") : `${id}-email-hint`}
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
            autoComplete="username"
            required
            maxLength={NAME_MAX}
            value={nickname}
            onChange={(e) => {
              setNickname(e.target.value);
              setErrors((v) => ({ ...v, nickname: undefined }));
            }}
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
            onChange={(e) => {
              setTermsAge(e.target.checked);
              setErrors((v) => ({ ...v, terms: false }));
            }}
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
        <button
          type="submit"
          className="btn primary big"
          data-testid="play"
          disabled={sending || disabled}
        >
          {sending ? t.t("start.getReady") : t.t("start.play")}
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

/** The score action uses a fresh challenge after the run, without asking for details again. */
export function SaveScreen({
  onSubmit,
}: {
  onSubmit: (token: string) => Promise<SaveErrorKey | null>;
}) {
  const { t, lang } = useUi();
  const box = useRef<HTMLDivElement>(null);
  const challenge = useTurnstile(box, lang);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<SaveErrorKey | null>(null);
  return (
    <section>
      <button
        className="btn primary big"
        data-testid="save"
        disabled={sending}
        onClick={async () => {
          if (sending) return;
          setSending(true);
          try {
            setError(await onSubmit(await challenge.getToken()));
          } catch {
            setError("save.errors.network");
          } finally {
            challenge.reset();
            setSending(false);
          }
        }}
      >
        {sending ? t.t("save.sending") : t.t("save.cta")}
      </button>
      {error && (
        <p className="error" role="alert">
          {t.t(error)}
        </p>
      )}
      {TURNSTILE_ENABLED && <div ref={box} className="turnstile" />}
    </section>
  );
}
