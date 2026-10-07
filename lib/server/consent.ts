/**
 * Consent records (DATA-03, L10N-07). The text stored is exactly what the save form shows, from
 * the same i18n entry, without link markup, with that language's version label. When counsel
 * changes the wording, bump `consent.version` in that language's file.
 */
import type { Queryable } from "@/db/client";
import { newConsent } from "@/db/schema";
import { createTranslator, splitRich, type Lang } from "@/i18n";

export type ConsentKind = "terms_age" | "marketing";
export type ConsentSource = "save_form";

const KEYS = { terms_age: "consent.terms", marketing: "consent.marketing" } as const;

/** The text shown for a consent, and the version it belongs to. */
export function consentText(lang: Lang, kind: ConsentKind): { text: string; version: string } {
  const t = createTranslator(lang);
  return {
    text: splitRich(t.t(KEYS[kind]))
      .map((p) => p.text)
      .join(""),
    version: t.t("consent.version"),
  };
}

export interface ConsentInput {
  playerId: string;
  kind: ConsentKind;
  lang: Lang;
  source: ConsentSource;
  ip: string | null;
  userAgent: string | null;
  hostOrigin: string | null;
}

/** Appends a consent row. This is the only write the consent log gets, besides a purge. */
export async function recordConsent(q: Queryable, c: ConsentInput): Promise<void> {
  const { text, version } = consentText(c.lang, c.kind);
  await q.consents.insertOne(
    newConsent({
      playerId: c.playerId,
      kind: c.kind,
      granted: true,
      text,
      textVersion: version,
      language: c.lang,
      source: c.source,
      ip: c.ip,
      userAgent: c.userAgent?.slice(0, 400) ?? null,
      hostOrigin: c.hostOrigin,
    }),
  );
}
