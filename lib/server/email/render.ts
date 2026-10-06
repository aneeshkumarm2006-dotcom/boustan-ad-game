import { render } from "@react-email/render";
import { CouponEmail, couponSubject, type CouponEmailProps } from "@/emails/CouponEmail";
import type { RewardId } from "@/game-core";
import type { Lang } from "@/i18n";
import { LEGAL } from "@/lib/legal";
import { CAMPAIGN_ID, outboundUrl } from "@/lib/links";
import { env } from "../env";
import { emailViewTokenSchema, signToken, unsubscribeTokenSchema } from "../tokens";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  unsubscribeUrl: string;
}

export interface CouponEmailData {
  emailId: string;
  playerId: string;
  lang: Lang;
  resend: boolean;
  src: string | null;
  codes: { reward: RewardId; code: string; expiresAt: string }[];
}

/** Links for the email: UTM-tagged outbound links, signed unsubscribe and language links. */
export function emailLinks(d: CouponEmailData): CouponEmailProps["links"] {
  const { appUrl } = env();
  const other: Lang = d.lang === "fr" ? "en" : "fr";
  const unsub = signToken("unsubscribe", {
    v: 1,
    p: d.playerId,
  } satisfies typeof unsubscribeTokenSchema._output);
  const view = signToken("email_view", {
    v: 1,
    e: d.emailId,
  } satisfies typeof emailViewTokenSchema._output);
  const play = new URL(`${appUrl}/`);
  play.searchParams.set("lang", d.lang);
  play.searchParams.set("src", "email");
  play.searchParams.set("utm_source", "email");
  play.searchParams.set("utm_campaign", CAMPAIGN_ID);
  return {
    findBoustan: outboundUrl("findBoustan", d.lang, d.src, "email"),
    orderOnline: outboundUrl("orderOnline", d.lang, d.src, "email"),
    fullTerms: outboundUrl("terms", d.lang, d.src, "email"),
    privacy: outboundUrl("privacy", d.lang, d.src, "email"),
    playAgain: play.toString(),
    unsubscribe: `${appUrl}/api/unsubscribe?t=${unsub}`,
    otherLanguage: `${appUrl}/api/email/view?t=${view}&lang=${other}`,
  };
}

export async function renderCouponEmail(d: CouponEmailData): Promise<RenderedEmail> {
  const links = emailLinks(d);
  const element = CouponEmail({
    lang: d.lang,
    resend: d.resend,
    codes: d.codes,
    links,
    legal: { ...LEGAL, contact: env().EMAIL_REPLY_TO ?? LEGAL.contact },
    // The logo and the web fonts are served by the app itself.
    appUrl: env().appUrl,
  });
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return {
    subject: couponSubject(
      d.lang,
      d.codes.map((c) => c.reward),
    ),
    html,
    text,
    unsubscribeUrl: links.unsubscribe,
  };
}
