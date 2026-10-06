import { describe, expect, it } from "vitest";
import { isValidNickname, looksLikeEmail, maskEmail, normalizeEmail } from "./email";
import { outboundUrl, shareUrl, withUtm } from "./links";

describe("outbound links (EMB-09)", () => {
  it("adds the standard UTMs", () => {
    const url = new URL(withUtm("https://www.boustan.ca/locations?x=1", "lapresse"));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      x: "1",
      utm_source: "game",
      utm_medium: "embed",
      utm_campaign: "game-2026",
      utm_content: "lapresse",
    });
  });

  it("omits utm_content without a placement", () => {
    expect(outboundUrl("findBoustan", "fr", null)).not.toContain("utm_content");
  });
});

describe("shareUrl (GAME-16)", () => {
  it("defaults to the standalone URL with src=share", () => {
    expect(shareUrl("https://jeu.boustan.ca")).toBe("https://jeu.boustan.ca/?src=share");
  });
});

describe("email helpers", () => {
  it("checks the basic shape", () => {
    expect(looksLikeEmail(" a.b+tag@gmail.com ")).toBe(true);
    expect(looksLikeEmail("a@b")).toBe(false);
    expect(looksLikeEmail("a b@c.ca")).toBe(false);
    expect(looksLikeEmail("")).toBe(false);
    expect(looksLikeEmail("marie-ève@sympatico.ca")).toBe(false);
  });

  it("normalizes Gmail dots and +tags so variants match (RWD-05, AC-03)", () => {
    expect(normalizeEmail(" A.Lex+game@Gmail.com ")).toBe("alex@gmail.com");
    expect(normalizeEmail("a.lex@googlemail.com")).toBe("alex@gmail.com");
    expect(normalizeEmail("a.lex+x@videotron.ca")).toBe("a.lex@videotron.ca");
    expect(normalizeEmail("nobody")).toBe("nobody");
  });

  it("masks all but the first letter", () => {
    expect(maskEmail("alex@gmail.com")).toBe("a•••@gmail.com");
    expect(maskEmail("bad")).toBe("•••");
  });

  it("applies the nickname rules", () => {
    expect(isValidNickname("Toum Turbo 81")).toBe(true);
    expect(isValidNickname("Élodie_O'Neil")).toBe(true);
    expect(isValidNickname("x")).toBe(false);
    expect(isValidNickname("a".repeat(17))).toBe(false);
    expect(isValidNickname("<b>hi</b>")).toBe(false);
  });
});
