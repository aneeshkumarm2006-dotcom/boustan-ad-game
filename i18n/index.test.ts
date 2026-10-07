import { describe, expect, it } from "vitest";
import { createTranslator, interpolate, pickLanguage, splitRich } from "./index";

describe("pickLanguage (L10N-02)", () => {
  it("prefers ?lang, then the saved choice, then the browser, then French", () => {
    expect(pickLanguage({ param: "en", saved: "fr", browser: ["fr-CA"] })).toBe("en");
    expect(pickLanguage({ param: "EN" })).toBe("en");
    expect(pickLanguage({ param: "de", saved: "en", browser: ["fr-CA"] })).toBe("en");
    expect(pickLanguage({ saved: "fr", browser: ["en-US"] })).toBe("fr");
    expect(pickLanguage({ browser: ["fr-CA", "en"] })).toBe("fr");
    expect(pickLanguage({ browser: ["fr"] })).toBe("fr");
    expect(pickLanguage({ browser: ["en-CA", "fr"] })).toBe("en");
    expect(pickLanguage({ browser: ["es-MX"] })).toBe("en");
    expect(pickLanguage({})).toBe("fr");
    expect(pickLanguage({ param: null, saved: "garbage", browser: [] })).toBe("fr");
  });
});

describe("createTranslator", () => {
  const fr = createTranslator("fr");
  const en = createTranslator("en");

  it("looks up keys and fills placeholders", () => {
    expect(fr.t("start.play")).toBe("COURS, POULET, COURS");
    expect(en.t("start.winners", { n: 3 })).toBe("THE TOP 3 ON THE LEADERBOARD WIN");
    expect(fr.t("campaign.notStarted", { date: "15 oct. 2026" })).toBe(
      "Le concours commence le 15 oct. 2026. Échauffez-vous!",
    );
  });

  it("returns lists and picks plural forms by locale", () => {
    expect(en.list("canvas.hits")).toContain("BAWK!");
    expect(fr.list("milestone.every", { n: 300 })[0]).toBe("300 PTS · LÉGENDAIRE");
    // French treats 0 and 1 as singular; English only 1.
    expect(fr.plural("common.pts", 1, { n: 1 })).toBe("1 PT");
    expect(fr.plural("common.pts", 0, { n: 0 })).toBe("0 PT");
    expect(en.plural("common.pts", 0, { n: 0 })).toBe("0 PTS");
    expect(fr.plural("results.byGarlic", 1, { n: 1, x: 10 })).toBe("1 sauce à l'ail × 10");
    expect(fr.plural("results.byGarlic", 3, { n: 3, x: 10 })).toBe("3 sauces à l'ail × 10");
    const share = { points: 82, distance: 52, n: 3 };
    expect(fr.plural("share.text", 3, { ...share, garlic: 3 })).toContain(
      "52 m + 3 sauces à l'ail",
    );
    expect(en.plural("share.text", 1, { ...share, garlic: 1 })).toBe(
      "I scored 82 points in Save the Chicken (52 m + 1 garlic). Can you make the top 3?",
    );
  });

  it("formats numbers and dates per language (L10N-06)", () => {
    expect(fr.num(12345.7)).toBe("12 345");
    expect(en.num(12345.7)).toBe("12,345");
    const day = new Date(2026, 9, 15, 12);
    // No-break spaces, so a date never splits across lines.
    expect(fr.date(day)).toBe("15 oct. 2026");
    expect(en.date(day)).toBe("Oct 15, 2026");
  });
});

describe("text helpers", () => {
  it("leaves unknown placeholders alone", () => {
    expect(interpolate("{a} and {b}", { a: 1 })).toBe("1 and {b}");
  });

  it("splits rich text into plain and tagged parts", () => {
    expect(splitRich("Accept the <terms>terms</terms> and <privacy>policy</privacy>.")).toEqual([
      { text: "Accept the " },
      { text: "terms", tag: "terms" },
      { text: " and " },
      { text: "policy", tag: "privacy" },
      { text: "." },
    ]);
    expect(splitRich("plain")).toEqual([{ text: "plain" }]);
  });
});
