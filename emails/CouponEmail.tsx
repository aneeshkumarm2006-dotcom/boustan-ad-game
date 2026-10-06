/**
 * Coupon email (MAIL-03 to MAIL-06): one email for every code claimed together, one block per
 * code with the code in large monospace and its expiry. No images, so the code reads the same
 * with images off; the plain-text version is generated from this markup. All text comes from
 * the i18n files (L10N-01).
 */
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import type { RewardId } from "@/game-core";
import { createTranslator, type Lang } from "@/i18n";

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
}

const BRAND = { red: "#E1251B", cream: "#F3EFEA", green: "#073F36", charcoal: "#252525" };
const FONT = "Helvetica, Arial, sans-serif";
const MONO = "'Courier New', Courier, monospace";

export function couponSubject(lang: Lang, rewards: readonly RewardId[]): string {
  const t = createTranslator(lang);
  if (rewards.includes("free_coke") && rewards.includes("free_garlic_sauce")) {
    return t.t("email.subject.both");
  }
  return t.t(
    rewards.includes("free_coke") ? "email.subject.free_coke" : "email.subject.free_garlic_sauce",
  );
}

export function CouponEmail({ lang, resend, codes, links, legal }: CouponEmailProps) {
  const t = createTranslator(lang);
  const many = codes.length > 1;
  return (
    <Html lang={lang}>
      <Head />
      <Preview>{t.t("email.preview")}</Preview>
      <Body
        style={{ backgroundColor: BRAND.cream, margin: 0, padding: "24px 0", fontFamily: FONT }}
      >
        <Container
          style={{
            maxWidth: 560,
            backgroundColor: "#ffffff",
            border: `3px solid ${BRAND.charcoal}`,
          }}
        >
          <Section style={{ backgroundColor: BRAND.red, padding: "14px 24px" }}>
            <Text
              style={{
                margin: 0,
                color: BRAND.cream,
                fontSize: 22,
                fontWeight: 700,
                letterSpacing: 3,
              }}
            >
              BOUSTAN
            </Text>
            <Text style={{ margin: 0, color: BRAND.cream, fontSize: 13 }}>
              {t.t("brand.titleTop")} {t.t("brand.titleBottom")}
              {" · "}
              <Link
                href={links.otherLanguage}
                lang={lang === "fr" ? "en" : "fr"}
                style={{ color: BRAND.cream, textDecoration: "underline" }}
              >
                {t.t("email.otherLanguage")}
              </Link>
            </Text>
          </Section>

          <Section style={{ padding: "8px 24px 0" }}>
            <Heading as="h1" style={{ color: BRAND.charcoal, fontSize: 24, margin: "16px 0 8px" }}>
              {t.t("email.heading")}
            </Heading>
            <Text style={text}>
              {resend ? t.t("email.resent") : many ? t.t("email.introMany") : t.t("email.intro")}
            </Text>
          </Section>

          {codes.map((c) => (
            <Section key={c.code} style={{ padding: "0 24px" }}>
              <Section
                style={{
                  border: `2px dashed ${BRAND.green}`,
                  padding: "12px 16px",
                  margin: "12px 0",
                }}
              >
                <Text
                  style={{
                    ...text,
                    margin: 0,
                    fontWeight: 700,
                    color: BRAND.green,
                    textTransform: "uppercase",
                  }}
                >
                  {t.t(`reward.${c.reward}.name`)}
                </Text>
                <Text style={{ margin: "4px 0 0", fontSize: 12, color: BRAND.charcoal }}>
                  {t.t("email.code")}
                </Text>
                <Text
                  style={{
                    margin: "2px 0 6px",
                    fontFamily: MONO,
                    fontSize: 30,
                    fontWeight: 700,
                    letterSpacing: 3,
                    color: BRAND.charcoal,
                  }}
                >
                  {c.code}
                </Text>
                <Text style={{ ...text, margin: 0, fontWeight: 700 }}>
                  {t.t("email.expires", { date: t.date(c.expiresAt) })}
                </Text>
                <Text style={{ ...small, margin: "6px 0 0" }}>
                  {t.t(`reward.${c.reward}.terms`)}
                </Text>
              </Section>
            </Section>
          ))}

          <Section style={{ padding: "0 24px" }}>
            <Heading as="h2" style={{ color: BRAND.charcoal, fontSize: 16, margin: "12px 0 4px" }}>
              {t.t("email.howToTitle")}
            </Heading>
            <Text style={{ ...text, marginTop: 0 }}>
              {t.t("coupon.howTo")}{" "}
              <Link href={links.fullTerms} style={link}>
                {t.t("coupon.fullTerms")}
              </Link>
            </Text>
            <Section style={{ margin: "8px 0 4px" }}>
              <Button href={links.findBoustan} style={{ ...button, backgroundColor: BRAND.green }}>
                {t.t("email.findBoustan")}
              </Button>{" "}
              <Button href={links.orderOnline} style={{ ...button, backgroundColor: BRAND.red }}>
                {t.t("email.orderOnline")}
              </Button>
            </Section>
            <Text style={text}>
              <Link href={links.playAgain} style={link}>
                {t.t("email.playAgain")}
              </Link>
            </Text>
          </Section>

          <Hr style={{ borderColor: BRAND.charcoal, margin: "16px 24px" }} />
          <Section style={{ padding: "0 24px 16px" }}>
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
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

const text = { color: BRAND.charcoal, fontSize: 15, lineHeight: "22px" };
const small = { color: BRAND.charcoal, fontSize: 12, lineHeight: "18px", margin: "4px 0" };
const link = { color: BRAND.green, textDecoration: "underline" };
const button = {
  color: "#ffffff",
  fontSize: 14,
  fontWeight: 700,
  padding: "12px 16px",
  margin: "4px 4px 4px 0",
  textDecoration: "none",
};

export default CouponEmail;
