/**
 * Tiny standalone HTML pages served by route handlers (unsubscribe confirmation, email web
 * view). No scripts; a CSP that allows only inline styles and same-origin fonts and images.
 */
import { PALETTE, WORDMARK, mix } from "@/lib/brand";

const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": PAGE_CSP,
      "x-robots-tag": "noindex",
    },
  });
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Headings are sentence case: the guide never sets the display face in capitals. A heading that
 * arrives in capitals, like the game title "SAUVEZ LE POULET", is shown as "Sauvez le poulet".
 */
function sentenceCase(text: string): string {
  if (text !== text.toUpperCase() || text === text.toLowerCase()) return text;
  return text.charAt(0) + text.slice(1).toLowerCase();
}

/** Same-origin brand fonts (public/brand/fonts); the CSP allows font-src 'self'. */
const FONT_FACES = [
  { family: "Young Serif", weight: 400, file: "YoungSerif-Regular-latin" },
  { family: "Barlow Condensed", weight: 600, file: "BarlowCondensed-SemiBold-latin" },
  { family: "Inter", weight: 400, file: "Inter-Regular-latin" },
]
  .map(
    (f) =>
      `@font-face{font-family:"${f.family}";font-style:normal;font-weight:${f.weight};font-display:swap;src:url(/brand/fonts/${f.file}.woff2) format("woff2")}`,
  )
  .join("\n");

/**
 * Boustan look: Vert page, Toum card with a hard offset shadow (no blur), flat colour, square
 * corners, hairline rule. The only links are call-to-action buttons: Navet for the first
 * language, Vert for the second, so the accent stays sparing. Young Serif (display, sentence
 * case), Barlow Condensed (button, always upper case) and Inter (running text) stand in for
 * Ergon, Marr and Suisse.
 */
const STYLES = `${FONT_FACES}
*,::before,::after{box-sizing:border-box}
html{background:${PALETTE.vert};color-scheme:light}
body{margin:0;min-height:100vh;min-height:100dvh;display:flex;padding:20px 16px 32px;background:${PALETTE.vert};color:${PALETTE.vert};font:400 16px/1.5 Inter,"Helvetica Neue",Helvetica,Arial,sans-serif;font-synthesis:none;-webkit-text-size-adjust:100%}
main{width:100%;max-width:520px;margin:auto;padding:28px 20px 32px;background:${PALETTE.toum};box-shadow:0 6px 0 rgba(0,0,0,.6)}
.logo{display:block;width:150px;max-width:100%;height:auto;margin:0 0 28px}
h1{margin:0 0 12px;font:400 28px/1.15 "Young Serif",Georgia,"Times New Roman",serif;overflow-wrap:anywhere}
p{margin:0 0 16px;overflow-wrap:anywhere}
p:last-child{margin-bottom:0}
a{display:inline-block;min-height:44px;max-width:100%;padding:12px 24px;background:${PALETTE.navet};color:${PALETTE.toum};font:600 24px/1.2 "Barlow Condensed","Arial Narrow",Arial,sans-serif;letter-spacing:.06em;text-align:center;text-decoration:none;text-transform:uppercase}
a:hover{background:${PALETTE.vert}}
hr ~ section a{background:${PALETTE.vert}}
hr ~ section a:hover{background:${PALETTE.navet}}
:focus-visible{outline:3px solid ${PALETTE.navet};outline-offset:3px}
hr{margin:28px 0;border:0;border-top:1px solid ${mix(PALETTE.toum, PALETTE.vert, 0.22)}}
@media (min-width:560px){body{padding-top:48px}main{padding:40px 40px 44px}h1{font-size:34px}}`;

/** A small branded page with one section per language, the player's language first. */
export function simplePage(
  title: string,
  sections: {
    lang: string;
    heading: string;
    body: string;
    link?: { href: string; label: string };
  }[],
): string {
  const blocks = sections
    .map(
      (s) => `<section lang="${escapeHtml(s.lang)}">
  <h1>${escapeHtml(sentenceCase(s.heading))}</h1>
  <p>${escapeHtml(s.body)}</p>
  ${s.link ? `<p><a href="${escapeHtml(s.link.href)}">${escapeHtml(s.link.label)}</a></p>` : ""}
</section>`,
    )
    .join("\n<hr>\n");
  return `<!doctype html>
<html lang="${escapeHtml(sections[0]?.lang ?? "fr")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="${PALETTE.vert}">
<title>${escapeHtml(title)}</title>
<style>
${STYLES}
</style>
</head>
<body><main><svg class="logo" viewBox="0 0 ${WORDMARK.w} ${WORDMARK.h}" role="img" aria-label="Boustan"><path fill="${PALETTE.vert}" d="${WORDMARK.d}"/></svg>
${blocks}
</main></body>
</html>`;
}
