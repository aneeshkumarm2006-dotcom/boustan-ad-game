/**
 * Outbound links (PRD EMB-09) and the share link (GAME-16). Every outbound link opens in a new
 * tab with rel="noopener" and the standard UTMs.
 *
 * The URLs below are placeholders until Boustan confirms them [Boustan][Legal].
 */
import type { Lang } from "@/i18n";

export const CAMPAIGN_ID = process.env.NEXT_PUBLIC_CAMPAIGN_ID || "game-2026";

const URLS = {
  /** uEat ordering. */
  orderOnline: { fr: "https://www.boustan.ca/fr", en: "https://www.boustan.ca/" },
  /** Store locator. */
  findBoustan: {
    fr: "https://www.boustan.ca/fr/locations",
    en: "https://www.boustan.ca/locations",
  },
  /** Contest rules, privacy policy and privacy officer contact. */
  terms: { fr: "https://www.boustan.ca/fr", en: "https://www.boustan.ca/" },
  privacy: { fr: "https://www.boustan.ca/fr", en: "https://www.boustan.ca/" },
  privacyOfficer: { fr: "https://www.boustan.ca/fr", en: "https://www.boustan.ca/" },
} as const;

export type LinkTarget = keyof typeof URLS;

/** Adds utm_source=game&utm_medium=embed&utm_campaign=<campaign>&utm_content=<src>. */
export function withUtm(url: string, src: string | null) {
  const u = new URL(url);
  u.searchParams.set("utm_source", "game");
  u.searchParams.set("utm_medium", "embed");
  u.searchParams.set("utm_campaign", CAMPAIGN_ID);
  if (src) u.searchParams.set("utm_content", src);
  return u.toString();
}

export function outboundUrl(target: LinkTarget, lang: Lang, src: string | null): string {
  return withUtm(URLS[target][lang], src);
}

/**
 * "Challenge a friend" link: NEXT_PUBLIC_SHARE_URL when set, otherwise the standalone game
 * URL, always with src=share.
 */
export function shareUrl(origin: string): string {
  const u = new URL(process.env.NEXT_PUBLIC_SHARE_URL || `${origin}/`);
  u.searchParams.set("src", "share");
  return u.toString();
}
