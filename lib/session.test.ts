import { describe, expect, it } from "vitest";
import { attributionQuery, parseLaunchParams } from "./session";

describe("parseLaunchParams (EMB-02)", () => {
  it("reads lang, src, the four UTMs and muted", () => {
    const p = parseLaunchParams(
      "?lang=en&src=lapresse-home&utm_source=lapresse&utm_medium=display&utm_campaign=game-2026&utm_content=top&muted=0",
    );
    expect(p).toEqual({
      lang: "en",
      src: "lapresse-home",
      utm: {
        utm_source: "lapresse",
        utm_medium: "display",
        utm_campaign: "game-2026",
        utm_content: "top",
      },
      muted: false,
    });
  });

  it("ignores unknown parameters and blank or unsafe values", () => {
    const p = parseLaunchParams("?foo=1&utm_term=x&src=<script>&utm_source=&muted=yes");
    expect(p).toEqual({ lang: null, src: null, utm: {}, muted: null });
  });

  it("caps value length", () => {
    expect(parseLaunchParams(`?src=${"a".repeat(101)}`).src).toBeNull();
    expect(parseLaunchParams(`?src=${"a".repeat(100)}`).src).toHaveLength(100);
  });

  it("accepts accents in placement names", () => {
    expect(parseLaunchParams("?src=Montr%C3%A9al").src).toBe("Montréal");
  });
});

describe("attributionQuery", () => {
  it("carries lang, src and UTMs only", () => {
    const p = parseLaunchParams("?src=share&utm_campaign=c&muted=1&x=y");
    expect(attributionQuery(p, "fr")).toBe("lang=fr&src=share&utm_campaign=c");
  });
});
