import { describe, expect, it } from "vitest";
import en from "@/i18n/en.json";
import fr from "@/i18n/fr.json";
import { consentText } from "./consent";

describe("consent text (DATA-03, L10N-07)", () => {
  it("stores what the form shows, without link markup, with its version", () => {
    expect(consentText("en", "terms_age", true)).toEqual({
      text: "I'm 14 or older and I accept the offer terms and the privacy policy.",
      version: en.consent.version,
    });
    expect(consentText("fr", "marketing", true).text).toBe(fr.consent.marketing);
  });

  it("versions each language separately", () => {
    expect(consentText("fr", "terms_age", true).version).toBe(fr.consent.version);
    expect(fr.consent.version).not.toBe(en.consent.version);
  });

  it("has a withdrawal text for unsubscribes", () => {
    expect(consentText("fr", "marketing", false).text).toBe(fr.consent.withdrawn);
  });
});
