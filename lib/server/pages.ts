/**
 * Tiny standalone HTML pages served by route handlers (unsubscribe confirmation, email web
 * view). No scripts; a CSP that allows only inline styles.
 */
const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

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
      (s) => `<section lang="${s.lang}">
  <h1>${escapeHtml(s.heading)}</h1>
  <p>${escapeHtml(s.body)}</p>
  ${s.link ? `<p><a href="${escapeHtml(s.link.href)}">${escapeHtml(s.link.label)}</a></p>` : ""}
</section>`,
    )
    .join("\n<hr>\n");
  return `<!doctype html>
<html lang="${sections[0]?.lang ?? "fr"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; background: #F3EFEA; color: #252525; font: 16px/1.5 Helvetica, Arial, sans-serif; }
  main { max-width: 520px; margin: 32px auto; padding: 0 16px; }
  .brand { background: #E1251B; color: #F3EFEA; font-weight: 700; letter-spacing: 3px; padding: 12px 16px; border: 3px solid #252525; }
  section { background: #fff; border: 3px solid #252525; border-top: 0; padding: 8px 16px 12px; }
  h1 { font-size: 20px; margin: 12px 0 4px; }
  a { color: #073F36; }
  hr { display: none; }
</style>
</head>
<body><main><div class="brand">BOUSTAN</div>
${blocks}
</main></body>
</html>`;
}
