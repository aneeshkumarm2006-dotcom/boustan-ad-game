import localFont from "next/font/local";

/*
 * Boustan brand type system (Guide de style, automne 2025, p. 14-15).
 *
 * The guide specifies four commercial / custom families. This build ships free, OFL-licensed
 * stand-ins with the same roles, so nothing here needs a licence. To switch to the real fonts,
 * drop the licensed .woff2 files next to the stand-ins and change only the `src` lines below
 * (see ./fonts/README.md). CSS only ever uses the three variables.
 *
 *   role                      brand font                  stand-in (this folder)
 *   display  (--font-display)   Ergon Medium                Young Serif Regular
 *   condensed(--font-condensed) Marr Sans Condensed Semibold  Barlow Condensed SemiBold
 *   body     (--font-body)      Suisse Regular              Inter Regular
 *
 * Lateef (Arabic phrases) is not loaded: no screen shows Arabic text yet.
 */

/** Overline, H1 and headings. Sentence case, never all caps. */
export const displayFont = localFont({
  src: "./fonts/YoungSerif-Regular-latin.woff2",
  weight: "400",
  variable: "--font-display",
  display: "swap",
  adjustFontFallback: "Times New Roman",
  fallback: ["Georgia", "Times New Roman", "serif"],
});

/** Titles, sub-titles, buttons and labels. Always upper case (CSS text-transform). */
export const condensedFont = localFont({
  src: "./fonts/BarlowCondensed-SemiBold-latin.woff2",
  weight: "600",
  variable: "--font-condensed",
  display: "swap",
  adjustFontFallback: "Arial",
  fallback: ["Arial Narrow", "Arial", "sans-serif"],
});

/** Running text. Never all caps. Not preloaded for the canvas, but needed by the first overlay. */
export const bodyFont = localFont({
  src: "./fonts/Inter-Regular-latin.woff2",
  weight: "400",
  variable: "--font-body",
  display: "swap",
  adjustFontFallback: "Arial",
  fallback: ["Helvetica Neue", "Helvetica", "Arial", "sans-serif"],
});
