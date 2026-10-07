import { describe, expect, it } from "vitest";
import en from "@/i18n/en.json";
import fr from "@/i18n/fr.json";
import { consentText } from "./consent";

/** What the form shows for a consent: the dictionary entry with its link markup taken out. */
const plain = (text: string) => text.replace(/<\/?[a-z]+>/g, "");

describe("consent text (DATA-03, L10N-07)", () => {
  it("stores what the save form shows, without link markup, with its version", () => {
    expect(consentText("en", "terms_age")).toEqual({
      text: plain(en.consent.terms),
      version: en.consent.version,
    });
    expect(consentText("fr", "terms_age")).toEqual({
      text: plain(fr.consent.terms),
      version: fr.consent.version,
    });
    expect(consentText("en", "marketing").text).toBe(plain(en.consent.marketing));
    expect(consentText("fr", "marketing").text).toBe(plain(fr.consent.marketing));
  });

  it("never stores markup", () => {
    for (const lang of ["en", "fr"] as const) {
      for (const kind of ["terms_age", "marketing"] as const) {
        expect(consentText(lang, kind).text, `${lang} ${kind}`).not.toMatch(/[<>]/);
      }
    }
  });

  it("says which of the two consents it is, and in the player's language", () => {
    expect(consentText("fr", "terms_age").text).not.toBe(consentText("en", "terms_age").text);
    expect(consentText("en", "terms_age").text).not.toBe(consentText("en", "marketing").text);
  });

  it("versions each language separately", () => {
    expect(consentText("fr", "terms_age").version).toBe(fr.consent.version);
    expect(consentText("en", "marketing").version).toBe(en.consent.version);
    expect(fr.consent.version).not.toBe(en.consent.version);
  });
});
