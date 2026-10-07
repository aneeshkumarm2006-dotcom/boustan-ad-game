"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { looksLikeEmail } from "@/lib/email";
import { NICKNAME_MAX, autoNickname, nicknameProblem, type NicknameProblem } from "@/lib/nicknames";
import { useUi } from "./context";
import { BackArrow, DiceIcon, Overlay, RichText, Tools } from "./parts";
import { TURNSTILE_ENABLED, useTurnstile } from "./turnstile";

export interface SaveInput {
  email: string;
  nickname?: string;
  termsAge: boolean;
  marketingOptIn: boolean;
  /** Cloudflare Turnstile token; "" when Turnstile is off (SEC-05). */
  turnstileToken: string;
}

export type SaveErrorKey =
  | "save.errors.network"
  | "save.errors.expired"
  | "save.errors.rejected"
  | "save.errors.badEmail"
  | "save.errors.tooMany"
  | "save.errors.closed";

/** Translation key of the error to show, or null on success. */
export type SaveSubmit = (input: SaveInput) => Promise<SaveErrorKey | null>;

/**
 * "Save my score" (LB-02, DATA-01 to DATA-03): the email that puts a new player's run on the
 * leaderboard and lets Boustan reach the winners, an optional nickname, the 14+ and rules
 * checkbox and the optional offers opt-in. Values survive a failed submit so the player can
 * retry (§3.4).
 */
export function SaveScreen({
  points,
  onSubmit,
  onBack,
}: {
  points: number;
  onSubmit: SaveSubmit;
  onBack: () => void;
}) {
  const { t, lang } = useUi();
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
    terms?: boolean;
    nickname?: NicknameProblem;
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
      terms: !termsAge,
      nickname: nicknameProblem(nickname) ?? undefined,
    };
    setErrors(next);
    if (next.email || next.terms || next.nickname) {
      const first = next.email ? "email" : next.nickname ? "nickname" : "terms";
      document.getElementById(`${id}-${first}`)?.focus();
      return;
    }
    void send({
      email: email.trim(),
      nickname: nickname.trim() || undefined,
      termsAge,
      marketingOptIn: optIn,
    });
  }

  const errorId = (field: string) => `${id}-${field}-error`;
  return (
    <Overlay labelledBy={`${id}-title`}>
      <div className="card-bar">
        <button type="button" className="linkish" onClick={onBack}>
          <BackArrow /> {t.t("common.back")}
        </button>
        <Tools />
      </div>
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
          <div className="input-row">
            <input
              id={`${id}-nickname`}
              type="text"
              autoComplete="nickname"
              maxLength={NICKNAME_MAX}
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              aria-invalid={errors.nickname ? true : undefined}
              aria-describedby={errors.nickname ? errorId("nickname") : `${id}-nickname-hint`}
            />
            <button
              type="button"
              className="btn small-btn"
              onClick={() => {
                setNickname(autoNickname());
                setErrors((e) => ({ ...e, nickname: undefined }));
              }}
            >
              <DiceIcon />
              {t.t("save.reroll")}
            </button>
          </div>
          {errors.nickname ? (
            <p id={errorId("nickname")} className="error">
              {t.t(
                errors.nickname === "rude" ? "save.errors.nicknameRude" : "save.errors.nickname",
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
        <button type="submit" className="btn primary big" disabled={sending}>
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
    </Overlay>
  );
}
