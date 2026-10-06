/**
 * Renders the coupon email with sample codes to ./.emails/preview-*.html and .txt, in French
 * and English, one and two codes, for a look in a browser or a paste into an email tester:
 * `npm run email:preview`. The logo and the web fonts are fetched from APP_URL (default
 * http://localhost:3000; set it to a running copy of the app, e.g. APP_URL=http://localhost:3100).
 * Opened from disk, a browser shows the logo but blocks the fonts (CORS), so you see the system
 * fallbacks, as most email clients do.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { render } from "@react-email/render";
import { CouponEmail, couponSubject, type CouponEmailProps } from "../emails/CouponEmail";
import type { Lang } from "../i18n";
import { LEGAL } from "../lib/legal";
import { fail } from "./local-env";

const OUT = path.resolve(".emails");

async function main() {
  mkdirSync(OUT, { recursive: true });
  const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const appUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const links: CouponEmailProps["links"] = {
    findBoustan: "https://www.boustan.ca/locations",
    orderOnline: "https://www.boustan.ca/",
    playAgain: `${appUrl}/?src=email`,
    fullTerms: "https://www.boustan.ca/",
    privacy: "https://www.boustan.ca/",
    unsubscribe: `${appUrl}/api/unsubscribe?t=preview`,
    otherLanguage: `${appUrl}/api/email/view?t=preview`,
  };
  for (const lang of ["fr", "en"] as Lang[]) {
    for (const both of [false, true]) {
      const codes: CouponEmailProps["codes"] = [
        { reward: "free_coke", code: "TEST-7K2M-9QX4", expiresAt },
        ...(both
          ? [{ reward: "free_garlic_sauce" as const, code: "TEST-A3VD-ZP8R", expiresAt }]
          : []),
      ];
      const element = CouponEmail({ lang, resend: false, codes, links, legal: LEGAL, appUrl });
      const name = `preview-${lang}-${both ? "two" : "one"}`;
      writeFileSync(path.join(OUT, `${name}.html`), await render(element));
      const subject = couponSubject(
        lang,
        codes.map((c) => c.reward),
      );
      writeFileSync(
        path.join(OUT, `${name}.txt`),
        `Subject: ${subject}\n\n${await render(element, { plainText: true })}`,
      );
      console.log(`${name}: ${subject}`);
    }
  }
  console.log(`Written to ${OUT}`);
}

main().catch(fail);
