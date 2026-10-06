import { createTranslator, type Lang } from "@/i18n";
import { db } from "@/lib/server/db";
import { env } from "@/lib/server/env";
import { requestContext, withErrors } from "@/lib/server/http";
import { htmlResponse, simplePage } from "@/lib/server/pages";
import { unsubscribe } from "@/lib/server/unsubscribe";

function page(lang: Lang, ok: boolean): Response {
  const order: Lang[] = lang === "en" ? ["en", "fr"] : ["fr", "en"];
  const sections = order.map((l) => {
    const t = createTranslator(l);
    return {
      lang: l,
      heading: ok ? t.t("unsubscribe.title") : t.t("brand.game"),
      body: ok ? t.t("unsubscribe.body") : t.t("unsubscribe.invalid"),
      link: { href: `${env().appUrl}/?lang=${l}&src=unsubscribe`, label: t.t("unsubscribe.play") },
    };
  });
  return htmlResponse(simplePage(sections[0].heading, sections), ok ? 200 : 400);
}

async function run(request: Request) {
  const token = new URL(request.url).searchParams.get("t") ?? "";
  const ctx = requestContext(request);
  return unsubscribe(db(), token, { ip: ctx.ip, userAgent: ctx.userAgent, now: new Date() });
}

/** GET /api/unsubscribe?t=… — the signed link in every email (DATA-07, AC-07). */
export const GET = withErrors("unsubscribe", async (request: Request) => {
  const done = await run(request);
  return page(done?.lang ?? "fr", done !== null);
});

/** One-click unsubscribe from the mail client (RFC 8058, List-Unsubscribe-Post). */
export const POST = withErrors("unsubscribe", async (request: Request) => {
  const done = await run(request);
  return new Response(null, { status: done ? 200 : 400, headers: { "cache-control": "no-store" } });
});
