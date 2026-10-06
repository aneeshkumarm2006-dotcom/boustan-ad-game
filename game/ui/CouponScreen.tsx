"use client";

import { useState } from "react";
import type { RewardId } from "@/game-core";
import type { IssuedCode } from "@/lib/api";
import { useUi } from "./context";
import { OutLink, Overlay, PixelIcon, Tools } from "./parts";
import { copyText } from "./share";

export function CodeCard({ code }: { code: IssuedCode }) {
  const { t, toast } = useUi();
  const name = t.t(`reward.${code.reward}.name`);
  return (
    <article className="coupon" data-testid="coupon">
      <PixelIcon name={code.reward === "free_coke" ? "can" : "cup"} className="logo-sm" />
      <h3>{t.t(`reward.${code.reward}.short`)}</h3>
      <output className="code" aria-label={name}>
        {code.code}
      </output>
      <button
        type="button"
        className="btn"
        aria-label={t.t("coupon.copyLabel", { reward: name })}
        onClick={() =>
          copyText(code.code).then(
            () => toast(t.t("common.copied")),
            () => toast(t.t("common.copyFailed")),
          )
        }
      >
        {t.t("common.copy")}
      </button>
      <p>
        <b>{t.t("coupon.expires", { date: t.date(code.expiresAt) })}</b>
      </p>
      <p className="small" style={{ color: "inherit" }}>
        {t.t(`reward.${code.reward}.terms`)}{" "}
        <OutLink target="terms">{t.t("coupon.fullTerms")}</OutLink>
      </p>
    </article>
  );
}

/** Coupon screen (§3.2, RWD-06): code per reward, expiry, terms, how to redeem, resend. */
export function CouponScreen({
  codes,
  alreadyClaimed,
  unavailable,
  emailMasked,
  onResend,
  onPlayAgain,
}: {
  codes: IssuedCode[];
  alreadyClaimed: RewardId[];
  /** Unlocked but out of stock or paused at claim time (RWD-04). */
  unavailable: RewardId[];
  emailMasked: string | null;
  onResend: () => Promise<boolean>;
  onPlayAgain: () => void;
}) {
  const { t } = useUi();
  const [resend, setResend] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  return (
    <Overlay labelledBy="coupon-title">
      <div className="card-bar">
        <Tools />
      </div>
      <h2 id="coupon-title" className="heading" tabIndex={-1} data-autofocus>
        {codes.length > 1
          ? t.t("coupon.titleMany")
          : codes.length === 0 && alreadyClaimed.length === 0
            ? t.t("coupon.titleNone")
            : t.t("coupon.title")}
      </h2>
      {codes.map((code) => (
        <CodeCard key={code.code} code={code} />
      ))}
      {alreadyClaimed.length > 0 && (
        <p className="note warn" role="status">
          {t.t("coupon.alreadyClaimed")}
        </p>
      )}
      {unavailable.map((id) => (
        <p key={id} className="note warn">
          {t.t("coupon.unavailable", { reward: t.t(`reward.${id}.name`) })}
        </p>
      ))}
      <p className="small">{t.t("coupon.howTo")}</p>
      {emailMasked && <p className="small">{t.t("coupon.sentTo", { email: emailMasked })}</p>}
      <div className="btn-row">
        <OutLink target="orderOnline" className="btn primary">
          {t.t("common.orderOnline")}
        </OutLink>
        <OutLink target="findBoustan" className="btn">
          {t.t("common.findBoustan")}
        </OutLink>
      </div>
      <div className="btn-row">
        <button type="button" className="btn" onClick={onPlayAgain}>
          {t.t("common.playAgain")}
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={resend === "sending" || resend === "sent"}
          onClick={async () => {
            setResend("sending");
            setResend((await onResend()) ? "sent" : "failed");
          }}
        >
          {resend === "sent" ? t.t("coupon.resent") : t.t("coupon.resend")}
        </button>
      </div>
      {resend === "failed" && (
        <p className="error" role="alert">
          {t.t("claim.errors.network")}
        </p>
      )}
    </Overlay>
  );
}
