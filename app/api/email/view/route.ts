import { eq } from "drizzle-orm";
import { emailOutbox } from "@/db/schema";
import { createTranslator, isLang } from "@/i18n";
import { db } from "@/lib/server/db";
import { loadCouponLines } from "@/lib/server/email/deliver";
import { renderCouponEmail } from "@/lib/server/email/render";
import { withErrors } from "@/lib/server/http";
import { htmlResponse, simplePage } from "@/lib/server/pages";
import { emailViewTokenSchema, verifyToken } from "@/lib/server/tokens";

/**
 * GET /api/email/view?t=…&lang=en — the coupon email in the other language (MAIL-03). The
 * signed token names one email; it shows the same codes the email holds.
 */
export const GET = withErrors("email_view", async (request: Request) => {
  const url = new URL(request.url);
  const langParam = url.searchParams.get("lang");
  const lang = isLang(langParam) ? langParam : "fr";
  const invalid = () => {
    const t = createTranslator(lang);
    return htmlResponse(
      simplePage(t.t("brand.game"), [
        { lang, heading: t.t("brand.game"), body: t.t("email.viewInvalid") },
      ]),
      404,
    );
  };
  const payload = verifyToken("email_view", url.searchParams.get("t") ?? "", emailViewTokenSchema);
  if (!payload) return invalid();

  const q = db();
  const [email] = await q.select().from(emailOutbox).where(eq(emailOutbox.id, payload.e));
  if (!email) return invalid();
  const { lines, src } = await loadCouponLines(q, email);
  if (lines.length === 0) return invalid();

  const rendered = await renderCouponEmail({
    emailId: email.id,
    playerId: email.playerId,
    lang,
    resend: email.kind !== "coupon",
    src,
    codes: lines,
  });
  return htmlResponse(rendered.html);
});
