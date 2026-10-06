/**
 * Coupon email (MAIL-03 to MAIL-06): one email for every code claimed together, one block per
 * code. The codes are live text, never images, so they read the same with images off; the
 * logo is the only picture and falls back to its alt text. The plain-text version is generated
 * from this markup. All text comes from the i18n files (L10N-01).
 *
 * Look: Boustan's guide de style. Toum page, Vert header band and code blocks, one Navet
 * button, flat colour, square corners, hairline rules, no shadows. Email clients mostly can't
 * load web fonts, so every stack falls back to a system face; Apple Mail and iOS Mail do load
 * the @font-face files served from the app (public/brand/fonts).
 */
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Text,
} from "@react-email/components";
import type { CSSProperties, ReactNode } from "react";
import type { RewardId } from "@/game-core";
import { createTranslator, type Lang } from "@/i18n";
import { PALETTE, mix } from "@/lib/brand";

export interface CouponEmailProps {
  lang: Lang;
  /** A re-send of codes the player already had (MAIL-08). */
  resend: boolean;
  codes: { reward: RewardId; code: string; expiresAt: string }[];
  links: {
    findBoustan: string;
    orderOnline: string;
    playAgain: string;
    fullTerms: string;
    privacy: string;
    unsubscribe: string;
    otherLanguage: string;
  };
  legal: { name: string; address: string; contact: string };
  /** Absolute base URL of the app (no trailing slash): where the logo and the fonts are served. */
  appUrl: string;
}

const WIDTH = 560;

const COLOR = {
  vert: PALETTE.vert,
  toum: PALETTE.toum,
  navet: PALETTE.navet,
  avocat: PALETTE.avocat,
  /** Hairline on Toum: Vert at 22%. */
  line: mix(PALETTE.toum, PALETTE.vert, 0.22),
  /** Hairline on Vert: Toum at 25%. */
  lineOnVert: mix(PALETTE.vert, PALETTE.toum, 0.25),
};

// Young Serif for headings (sentence case, weight 400 only), Barlow Condensed SemiBold for
// labels and buttons, Inter for running text: stand-ins for Ergon, Marr and Suisse.
const DISPLAY = "'Young Serif', Georgia, 'Times New Roman', serif";
const CONDENSED = "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif";
const BODY = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif";
// Codes are case-sensitive printable ASCII, read aloud and typed in: a monospace keeps 0/O and
// I/l/1 apart (PRD MAIL-04). The one place the brand type gives way to legibility.
const MONO = "Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace";

const FONT_FILES = [
  { family: "Young Serif", weight: 400, file: "YoungSerif-Regular-latin.woff2" },
  { family: "Barlow Condensed", weight: 600, file: "BarlowCondensed-SemiBold-latin.woff2" },
  { family: "Inter", weight: 400, file: "Inter-Regular-latin.woff2" },
] as const;

/**
 * Head styles. Light only: the palette is the brand, so clients that honour color-scheme
 * (Apple Mail, iOS Mail, Outlook apps) keep it instead of inverting it. The data-detectors
 * rule stops iOS from turning the expiry date and the address into blue links. The media query
 * tightens the side padding and the code size on phones and stacks the buttons full width
 * (Gmail, Apple Mail and Outlook apps run it; elsewhere the buttons simply wrap).
 */
function headCss(appUrl: string): string {
  const faces = FONT_FILES.map(
    (f) =>
      `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weight};font-display:swap;src:url('${appUrl}/brand/fonts/${f.file}') format('woff2');}`,
  ).join("\n");
  return `${faces}
:root{color-scheme:light only;supported-color-schemes:light only;}
body{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
h1,h2{font-synthesis:none;}
a[x-apple-data-detectors]{color:inherit !important;text-decoration:inherit !important;font-family:inherit !important;font-size:inherit !important;font-weight:inherit !important;line-height:inherit !important;}
@media (max-width:480px){
.px{padding-left:20px !important;padding-right:20px !important;}
.h1{font-size:28px !important;line-height:34px !important;}
.code{font-size:22px !important;line-height:28px !important;letter-spacing:0 !important;}
.btn{display:block !important;margin:0 0 10px !important;text-align:center !important;}
}`;
}

export function couponSubject(lang: Lang, rewards: readonly RewardId[]): string {
  const t = createTranslator(lang);
  if (rewards.includes("free_coke") && rewards.includes("free_garlic_sauce")) {
    return t.t("email.subject.both");
  }
  return t.t(
    rewards.includes("free_coke") ? "email.subject.free_coke" : "email.subject.free_garlic_sauce",
  );
}

/**
 * A full-width block. The padding sits on the cell, which Outlook honours (it ignores padding on
 * a table); `bg` goes on the table too, for clients that only read the attribute.
 */
function Box({
  bg,
  padding,
  className,
  style,
  children,
}: {
  bg?: string;
  padding?: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <table
      role="presentation"
      width="100%"
      border={0}
      cellPadding={0}
      cellSpacing={0}
      bgcolor={bg}
      style={{ width: "100%" }}
    >
      <tbody>
        <tr>
          <td className={className} style={{ backgroundColor: bg, padding, ...style }}>
            {children}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/**
 * A centred 560 px column. Outlook for Windows ignores max-width and reads the width attribute;
 * everywhere else the CSS (full width up to 560 px) wins over the attribute.
 */
function Column({ children }: { children: ReactNode }) {
  return (
    <Container width={WIDTH} style={{ width: "100%", maxWidth: WIDTH }}>
      {children}
    </Container>
  );
}

export function CouponEmail({ lang, resend, codes, links, legal, appUrl }: CouponEmailProps) {
  const t = createTranslator(lang);
  const many = codes.length > 1;
  return (
    <Html lang={lang}>
      <Head>
        <title>
          {couponSubject(
            lang,
            codes.map((c) => c.reward),
          )}
        </title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light only" />
        <meta name="supported-color-schemes" content="light only" />
        <style dangerouslySetInnerHTML={{ __html: headCss(appUrl) }} />
      </Head>
      <Preview>{t.t("email.preview")}</Preview>
      <Body style={{ backgroundColor: COLOR.toum, margin: 0, padding: 0, fontFamily: BODY }}>
        <Box bg={COLOR.vert}>
          <Column>
            <Box bg={COLOR.vert} padding="24px 28px 22px" className="px">
              <Img
                src={`${appUrl}/brand/boustan-logotype-toum@2x.png`}
                alt={t.t("brand.logoAlt")}
                // 480 x 98 at 152 px is 31 px tall: Outlook reads the attributes, not height:auto.
                width={152}
                height={31}
                style={{
                  width: 152,
                  height: "auto",
                  // What shows with images off: the alt text, in the header's own colours.
                  color: COLOR.toum,
                  fontFamily: CONDENSED,
                  fontSize: 24,
                  fontWeight: 600,
                  lineHeight: "31px",
                  letterSpacing: 1,
                }}
              />
              {/* The logo is a picture: this keeps the name in the plain-text version. */}
              <Text style={{ display: "none", margin: 0, msoHide: "all" } as CSSProperties}>
                BOUSTAN
              </Text>
              <Text style={{ ...label, margin: "14px 0 0", fontSize: 14, color: COLOR.toum }}>
                {t.t("brand.titleTop")} {t.t("brand.titleBottom")}
                {" · "}
                <Link
                  href={links.otherLanguage}
                  lang={lang === "fr" ? "en" : "fr"}
                  style={{ color: COLOR.toum, textDecoration: "underline" }}
                >
                  {t.t("email.otherLanguage")}
                </Link>
              </Text>
            </Box>
          </Column>
        </Box>

        <Column>
          <Box padding="32px 28px 8px" className="px">
            <Heading as="h1" className="h1" style={heading}>
              {t.t("email.heading")}
            </Heading>
            <Text style={{ ...text, margin: "12px 0 0" }}>
              {resend ? t.t("email.resent") : many ? t.t("email.introMany") : t.t("email.intro")}
            </Text>
          </Box>

          {codes.map((c) => (
            <Box key={c.code} padding="12px 28px 0" className="px">
              <Box bg={COLOR.vert} padding="20px 24px 20px">
                <Text style={{ ...label, margin: 0, fontSize: 16, color: COLOR.avocat }}>
                  {t.t(`reward.${c.reward}.name`)}
                </Text>
                <Text style={{ ...label, margin: "16px 0 0", fontSize: 13, color: COLOR.toum }}>
                  {t.t("email.code")}
                </Text>
                {/* Shown exactly as stored (no text-transform: codes can be mixed case); a long one wraps instead of overflowing. */}
                <Text
                  className="code"
                  style={{
                    margin: "2px 0 8px",
                    fontFamily: MONO,
                    fontWeight: 700,
                    fontSize: 30,
                    lineHeight: "38px",
                    letterSpacing: 1,
                    color: COLOR.toum,
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                  }}
                >
                  {c.code}
                </Text>
                <Text style={{ ...label, margin: "0 0 16px", fontSize: 15, color: COLOR.toum }}>
                  {t.t("email.expires", { date: t.date(c.expiresAt) })}
                </Text>
                <Box padding="16px 0 0" style={{ borderTop: `1px solid ${COLOR.lineOnVert}` }}>
                  <Text style={{ ...small, margin: 0, color: COLOR.toum }}>
                    {t.t(`reward.${c.reward}.terms`)}
                  </Text>
                </Box>
              </Box>
            </Box>
          ))}

          <Box padding="28px 28px 0" className="px">
            <Heading as="h2" style={{ ...heading, fontSize: 22, lineHeight: "28px" }}>
              {t.t("email.howToTitle")}
            </Heading>
            <Text style={{ ...text, margin: "8px 0 0" }}>
              {t.t("coupon.howTo")}{" "}
              <Link href={links.fullTerms} style={{ ...link, whiteSpace: "nowrap" }}>
                {t.t("coupon.fullTerms")}
              </Link>
            </Text>
            <Text style={{ margin: "20px 0 0", lineHeight: "100%" }}>
              <Button
                href={links.findBoustan}
                className="btn"
                style={{ ...button, ...buttonOutline }}
              >
                {t.t("email.findBoustan")}
              </Button>{" "}
              <Button
                href={links.orderOnline}
                className="btn"
                style={{ ...button, ...buttonPrimary }}
              >
                {t.t("email.orderOnline")}
              </Button>
            </Text>
            <Text style={{ ...text, margin: "12px 0 0" }}>
              <Link href={links.playAgain} style={link}>
                {t.t("email.playAgain")}
              </Link>
            </Text>
          </Box>

          <Box padding="32px 28px 0" className="px">
            <Hr style={{ margin: 0, borderTop: `1px solid ${COLOR.line}` }} />
          </Box>
          <Box padding="16px 28px 32px" className="px">
            <Text style={small}>{t.t("email.footer")}</Text>
            <Text style={small}>
              {legal.name}
              <br />
              {legal.address}
              <br />
              {t.t("email.contact", { email: legal.contact })}
            </Text>
            <Text style={small}>
              <Link href={links.privacy} style={link}>
                {t.t("email.privacy")}
              </Link>
              {" · "}
              <Link href={links.unsubscribe} style={link}>
                {t.t("email.unsubscribe")}
              </Link>
            </Text>
          </Box>
        </Column>
      </Body>
    </Html>
  );
}

/** Headings: display face, sentence case, Vert on Toum. Weight 400 is the only weight it has. */
const heading: CSSProperties = {
  margin: 0,
  color: COLOR.vert,
  fontFamily: DISPLAY,
  fontSize: 30,
  fontWeight: 400,
  lineHeight: "36px",
};
const text: CSSProperties = {
  color: COLOR.vert,
  fontFamily: BODY,
  fontSize: 16,
  lineHeight: "24px",
};
const small: CSSProperties = {
  color: COLOR.vert,
  fontFamily: BODY,
  fontSize: 13,
  lineHeight: "19px",
  margin: "6px 0",
};
/** Kickers and labels: condensed face, always upper case. */
const label: CSSProperties = {
  fontFamily: CONDENSED,
  fontWeight: 600,
  lineHeight: "20px",
  letterSpacing: 1.5,
  textTransform: "uppercase",
};
const link: CSSProperties = { color: COLOR.vert, textDecoration: "underline" };
/** Buttons: square, flat, condensed upper case. */
const button: CSSProperties = {
  ...label,
  fontSize: 20,
  padding: "14px 22px",
  margin: "0 8px 8px 0",
  borderRadius: 0,
  textDecoration: "none",
};
// 24px: Toum on Navet is 3.35:1, which only the large-text rule (>= 24px) allows.
const buttonPrimary: CSSProperties = {
  backgroundColor: COLOR.navet,
  color: COLOR.toum,
  fontSize: 24,
};
const buttonOutline: CSSProperties = {
  padding: "12px 20px",
  color: COLOR.vert,
  border: `2px solid ${COLOR.vert}`,
};

export default CouponEmail;
