import { describe, expect, it } from "vitest";
import { PALETTE, SYMBOL, WORDMARK, alpha, mix } from "./brand";

describe("brand palette (guide de style, palette de couleurs)", () => {
  it("holds the guide's hex values", () => {
    expect(PALETTE).toEqual({
      vert: "#073F36",
      toum: "#F4EEDF",
      navet: "#ED2B9A",
      hummus: "#EEC088",
      poivron: "#F48431",
      tomate: "#E2412B",
      avocat: "#EAF864",
      laitue: "#39B54A",
    });
  });

  it("keeps the CSS twin in app/globals.css in step", async () => {
    const { readFile } = await import("node:fs/promises");
    const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
    for (const [name, hex] of Object.entries(PALETTE)) {
      expect(css).toContain(`--${name}: ${hex.toLowerCase()};`);
    }
  });
});

describe("mix and alpha", () => {
  it("returns the endpoints and the midpoint", () => {
    expect(mix(PALETTE.vert, PALETTE.toum, 0)).toBe("#073F36");
    expect(mix(PALETTE.vert, PALETTE.toum, 1)).toBe("#F4EEDF");
    expect(mix("#000000", "#FFFFFF", 0.5)).toBe("#808080");
  });

  it("writes rgba() for glows and overlays", () => {
    expect(alpha(PALETTE.vert, 0.7)).toBe("rgba(7,63,54,0.7)");
  });
});

describe("official artwork", () => {
  it("is the traced vector, in boxes that start at the origin", () => {
    expect(WORDMARK.w).toBeGreaterThan(WORDMARK.h * 4);
    expect(SYMBOL.h).toBeGreaterThan(SYMBOL.w);
    for (const art of [WORDMARK, SYMBOL]) {
      expect(art.d.startsWith("M ")).toBe(true);
      expect(art.d).toContain("Z");
    }
  });
});
