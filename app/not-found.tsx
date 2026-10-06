import type { Metadata } from "next";
import Link from "next/link";
import { createTranslator, LANGS } from "@/i18n";
import { WORDMARK } from "@/lib/brand";

export const metadata: Metadata = { title: "404 | Boustan", robots: { index: false } };

/** Unknown URLs: a brand card in both languages (the visitor's language isn't known here). */
export default function NotFound() {
  return (
    <div className="app">
      <main className="card spark">
        <svg
          className="logo"
          viewBox={`0 0 ${WORDMARK.w} ${WORDMARK.h}`}
          role="img"
          aria-label="Boustan"
        >
          <path d={WORDMARK.d} fill="currentColor" />
        </svg>
        {LANGS.map((lang) => {
          const t = createTranslator(lang);
          return (
            <section key={lang} lang={lang} className="nf">
              <h1 className="heading">{t.t("notFound.title")}</h1>
              <p className="lede">{t.t("notFound.body")}</p>
              <p>
                <Link className="btn primary" href={`/?lang=${lang}`}>
                  {t.t("notFound.cta")}
                </Link>
              </p>
            </section>
          );
        })}
      </main>
    </div>
  );
}
