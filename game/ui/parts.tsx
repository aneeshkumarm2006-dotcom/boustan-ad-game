"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { LANGS, splitRich } from "@/i18n";
import type { RewardId, RewardRules } from "@/game-core";
import { WORDMARK } from "@/lib/brand";
import { outboundUrl, type LinkTarget } from "@/lib/links";
import { ART, type ArtName } from "../pixel-art";
import { useUi } from "./context";

/** Pixel art as crisp SVG, one rect per horizontal run of a colour. */
export function PixelIcon({ name, className }: { name: ArtName; className?: string }) {
  const art = ART[name];
  const rects: ReactNode[] = [];
  art.rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === ch) end++;
      const fill = (art.palette as Record<string, string>)[ch];
      if (fill)
        rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={end - x} height={1} fill={fill} />);
      x = end;
    }
  });
  return (
    <svg
      className={className}
      viewBox={`0 0 ${art.rows[0].length} ${art.rows.length}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      {rects}
    </svg>
  );
}

/** ✓ drawn as a stroke: the brand fonts have no check mark glyph. */
export function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M2.5 8.5 6.5 12.5 13.5 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="square"
      />
    </svg>
  );
}

export function PauseIcon() {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d="M1 0h3v10H1zM6 0h3v10H6z" fill="currentColor" />
    </svg>
  );
}

function SoundIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3 9h4l5-4v14l-5-4H3z" fill="currentColor" />
      <path
        d={on ? "M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" : "M16 9l6 6M22 9l-6 6"}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="square"
      />
    </svg>
  );
}

/** A die, drawn: the nickname re-roll used a colour emoji, which is off-palette. */
export function DiceIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect
        x="1.5"
        y="1.5"
        width="13"
        height="13"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path d="M4.5 4.5h2v2h-2zM9.5 4.5h2v2h-2zM6.5 9.5h3v2h-3z" fill="currentColor" />
    </svg>
  );
}

/** ← as a drawn arrow: it doesn't depend on the font having the glyph. */
export function BackArrow() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M14 8H3M7.5 3.5 3 8l4.5 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="square"
      />
    </svg>
  );
}

/**
 * The Boustan logotype, the official vector artwork (lib/brand.ts). It takes the colour of the
 * surrounding text, which the stylesheet sets to Toum on Vert and Vert on Toum, the only two
 * colours the guide allows here (besides black).
 */
export function BrandLogo({ small }: { small?: boolean }) {
  const { t } = useUi();
  return (
    <svg
      className={small ? "logo logo-sm" : "logo"}
      viewBox={`0 0 ${WORDMARK.w} ${WORDMARK.h}`}
      role="img"
      aria-label={t.t("brand.logoAlt")}
    >
      <path d={WORDMARK.d} fill="currentColor" />
    </svg>
  );
}

export function LangToggle() {
  const { lang, setLang, t } = useUi();
  return (
    <div className="toggle" role="group" aria-label={t.t("settings.language")}>
      {LANGS.map((l) => (
        <button key={l} type="button" lang={l} aria-pressed={lang === l} onClick={() => setLang(l)}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

export function SoundToggle() {
  const { muted, toggleMuted, t } = useUi();
  return (
    <button
      type="button"
      className="icon-btn"
      aria-pressed={!muted}
      aria-label={t.t("settings.sound")}
      title={t.t(muted ? "settings.soundOff" : "settings.soundOn")}
      onClick={toggleMuted}
    >
      <SoundIcon on={!muted} />
    </button>
  );
}

export function Tools() {
  return (
    <div className="bar-tools">
      <LangToggle />
      <SoundToggle />
    </div>
  );
}

/**
 * Full-screen dialog layer that scrolls inside the iframe when space is short (EMB-01). Focus
 * moves to the element marked data-autofocus, or the dialog itself.
 */
export function Overlay({
  labelledBy,
  children,
  focusKey,
  spark,
}: {
  labelledBy: string;
  children: ReactNode;
  /** Change it to move focus again (e.g. when a screen's content swaps). */
  focusKey?: string;
  /** Border of étincelles, for the start and coupon cards (guide: "avec parcimonie"). */
  spark?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>("[data-autofocus]") ?? root;
    target.focus({ preventScroll: true });
  }, [focusKey]);
  return (
    <div
      ref={ref}
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      tabIndex={-1}
    >
      <div className={spark ? "card spark" : "card"}>{children}</div>
    </div>
  );
}

/** Outbound link: new tab, rel="noopener", standard UTMs (EMB-09), cta_click to the host. */
export function OutLink({
  target,
  className,
  children,
}: {
  target: LinkTarget;
  className?: string;
  children: ReactNode;
}) {
  const { lang, src, emit, t } = useUi();
  return (
    <a
      className={className}
      href={outboundUrl(target, lang, src)}
      target="_blank"
      rel="noopener"
      onClick={() => emit({ type: "cta_click", data: { target } })}
    >
      {children}
      <span className="sr-only"> {t.t("common.newTab")}</span>
    </a>
  );
}

/** Renders "<tag>text</tag>" parts of a translation as outbound links. */
export function RichText({ text, links }: { text: string; links: Record<string, LinkTarget> }) {
  return (
    <>
      {splitRich(text).map((part, i) =>
        part.tag && links[part.tag] ? (
          <OutLink key={i} target={links[part.tag]}>
            {part.text}
          </OutLink>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

export type RewardStatus = "open" | "gone" | "unlocked" | "claimed" | "offline";

export function RewardCard({
  id,
  rules,
  status,
}: {
  id: RewardId;
  rules: RewardRules;
  status: RewardStatus;
}) {
  const { t } = useUi();
  const goal =
    id === "free_coke"
      ? t.t("reward.free_coke.goal", { m: rules.free_coke.distanceM })
      : t.t("reward.free_garlic_sauce.goal", { n: rules.free_garlic_sauce.garlic });
  const statusText =
    status === "gone"
      ? t.t("reward.allGone")
      : status === "unlocked"
        ? t.t("reward.unlocked")
        : status === "claimed"
          ? t.t("reward.claimed")
          : status === "offline"
            ? t.t("reward.needsConnection")
            : null;
  return (
    <div className="reward" data-status={status}>
      <PixelIcon name={id === "free_coke" ? "can" : "cup"} />
      <div>
        <div className="reward-goal">{goal}</div>
        <div className="reward-name">{t.t(`reward.${id}.short`)}</div>
        {statusText && <div className="reward-status">{statusText}</div>}
      </div>
    </div>
  );
}
