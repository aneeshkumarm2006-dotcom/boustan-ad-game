"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import type { RewardId, RewardRules } from "@/game-core";
import { looksLikeEmail } from "@/lib/email";
import { NICKNAME_MAX, autoNickname, nicknameProblem, type NicknameProblem } from "@/lib/nicknames";
import type { SavedPlayer } from "@/lib/player";
import { useUi } from "./context";
import { BackArrow, DiceIcon, Overlay, RewardCard, RichText, Tools } from "./parts";
import { TURNSTILE_ENABLED, useTurnstile } from "./turnstile";

export interface ClaimInput {
  email?: string;
  playerToken?: string;
  nickname?: string;
  termsAge: boolean;
  marketingOptIn: boolean;
  /** Cloudflare Turnstile token; "" when Turnstile is off (SEC-05). */
  turnstileToken?: string;
}

export type ClaimErrorKey =
  | "claim.errors.network"
  | "claim.errors.expired"
  | "claim.errors.rejected"
  | "claim.errors.badEmail"
  | "claim.errors.notRecognized"
  | "claim.errors.tooMany";

/** Translation key of the error to show, or null on success. */
export type ClaimSubmit = (input: ClaimInput) => Promise<ClaimErrorKey | null>;

/**
 * Claim form (§7.1), also used for "Save my score". Values survive a failed submit so the
 * player can retry (§3.4). A returning player gets a one-tap claim with "Not you?" (§3.3).
 */
export function ClaimScreen({
  mode,
  rewards,
  rules,
  player,
  onSubmit,
  onBack,
}: {
  mode: "claim" | "save";
  rewards: RewardId[];
  rules: RewardRules;
  player: SavedPlayer | null;
  onSubmit: ClaimSubmit;
  onBack: () => void;
}) {
  const { t, lang } = useUi();
  const id = useId();
  // Loads only now that the form is open (EMB-11), so a token is usually ready by submit.
  const turnstileBox = useRef<HTMLDivElement>(null);
  const turnstile = useTurnstile(turnstileBox, lang);
  const [oneTap, setOneTap] = useState(player !== null);
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

  const many = rewards.length > 1;
  const title =
    mode === "save"
      ? t.t("claim.titleSave")
      : many
        ? t.t("claim.titleMany")
        : t.t("claim.titleOne");
  const cta =
    mode === "save" ? t.t("claim.ctaSave") : many ? t.t("claim.ctaMany") : t.t("claim.cta");

  async function send(input: ClaimInput) {
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
    <Overlay labelledBy={`${id}-title`} focusKey={oneTap ? "tap" : "form"}>
      <div className="card-bar">
        <button type="button" className="linkish" onClick={onBack}>
          <BackArrow /> {t.t("common.back")}
        </button>
        <Tools />
      </div>
      <h2 id={`${id}-title`} className="heading">
        {title}
      </h2>
      {mode === "claim" && (
        <div className="rewards">
          {rewards.map((r) => (
            <RewardCard key={r} id={r} rules={rules} status="unlocked" />
          ))}
        </div>
      )}

      {oneTap && player ? (
        <div className="btn-stack">
          <p className="sub">{t.t("claim.recognized", { email: player.emailMasked })}</p>
          <button
            type="button"
            className="btn primary big"
            disabled={sending}
            data-autofocus
            onClick={() =>
              void send({ playerToken: player.token, termsAge: true, marketingOptIn: false })
            }
          >
            {sending
              ? t.t("claim.sending")
              : mode === "save"
                ? t.t("claim.oneTapSave")
                : many
                  ? t.t("claim.oneTapMany")
                  : t.t("claim.oneTap")}
          </button>
          <button type="button" className="linkish" onClick={() => setOneTap(false)}>
            {t.t("claim.notYou")}
          </button>
        </div>
      ) : (
        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor={`${id}-email`}>{t.t("claim.email")}</label>
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
                {t.t("claim.errors.email")}
              </p>
            ) : (
              <p id={`${id}-email-hint`} className="small">
                {mode === "save" ? t.t("claim.emailHintSave") : t.t("claim.emailHint")}
              </p>
            )}
          </div>
          <div className="field">
            <label htmlFor={`${id}-nickname`}>{t.t("claim.nickname")}</label>
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
                {t.t("claim.reroll")}
              </button>
            </div>
            {errors.nickname ? (
              <p id={errorId("nickname")} className="error">
                {t.t(
                  errors.nickname === "rude"
                    ? "claim.errors.nicknameRude"
                    : "claim.errors.nickname",
                )}
              </p>
            ) : (
              <p id={`${id}-nickname-hint`} className="small">
                {t.t("claim.nicknameHint")}
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
              <RichText
                text={t.t("consent.terms")}
                links={{ terms: "terms", privacy: "privacy" }}
              />
            </span>
          </label>
          {errors.terms && (
            <p id={errorId("terms")} className="error">
              {t.t("claim.errors.terms")}
            </p>
          )}
          <label className="check-row">
            <input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} />
            <span>{t.t("consent.marketing")}</span>
          </label>
          <button type="submit" className="btn primary big" disabled={sending}>
            {sending ? t.t("claim.sending") : cta}
          </button>
          <p className="privacy">
            <RichText
              text={t.t("claim.privacy")}
              links={{ policy: "privacy", officer: "privacyOfficer" }}
            />
          </p>
        </form>
      )}
      {failure && (
        <p className="error" role="alert">
          {failure}
        </p>
      )}
      {TURNSTILE_ENABLED && <div ref={turnstileBox} className="turnstile" />}
    </Overlay>
  );
}
