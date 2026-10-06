"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { LANGS, splitRich } from "@/i18n";
import type { RewardId, RewardRules } from "@/game-core";
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

/** ✓ drawn as pixels: the pixel fonts have no check mark glyph. */
export function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 7 6" shapeRendering="crispEdges" aria-hidden="true">
      <path
        d="M6 0h1v2H6zM5 2h1v1H5zM4 3h1v1H4zM3 4h1v1H3zM2 5h1v1H2zM1 4h1v1H1zM0 3h1v1H0z"
        fill="currentColor"
      />
    </svg>
  );
}

export function PauseIcon() {
  return (
    <svg viewBox="0 0 5 5" shapeRendering="crispEdges" aria-hidden="true">
      <path d="M0 0h2v5H0zM3 0h2v5H3z" fill="currentColor" />
    </svg>
  );
}

function SoundIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 9 8" shapeRendering="crispEdges" aria-hidden="true">
      <path d="M0 3h2v2H0zM2 2h1v4H2zM3 1h1v6H3zM4 0h1v8H4z" fill="currentColor" />
      {on ? (
        <path d="M6 3h1v2H6zM7 1h1v1H7zM8 2h1v4H8zM7 6h1v1H7z" fill="currentColor" />
      ) : (
        <path d="M6 2h1v1H6zM8 2h1v1H8zM7 3h1v2H7zM6 5h1v1H6zM8 5h1v1H8z" fill="currentColor" />
      )}
    </svg>
  );
}

/**
 * Placeholder wordmark until Boustan sends the logo SVG [Boustan]. Swap the contents of this
 * component for the real artwork; keep role="img" and the label.
 */
export function BrandLogo({ small }: { small?: boolean }) {
  const { t } = useUi();
  return (
    <svg
      className={small ? "logo logo-sm" : "logo"}
      viewBox="0 0 120 30"
      role="img"
      aria-label={t.t("brand.logoAlt")}
    >
      <rect x="1" y="1" width="118" height="28" fill="#E1251B" stroke="#000" strokeWidth="2" />
      <text
        x="60"
        y="20"
        textAnchor="middle"
        fill="#F3EFEA"
        style={{ font: "11px var(--font-pixel), monospace", letterSpacing: "1px" }}
      >
        BOUSTAN
      </text>
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
}: {
  labelledBy: string;
  children: ReactNode;
  /** Change it to move focus again (e.g. when a screen's content swaps). */
  focusKey?: string;
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
      <div className="card">{children}</div>
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
