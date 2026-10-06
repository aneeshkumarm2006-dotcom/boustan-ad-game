/**
 * Runs in every browser project (Chromium, Firefox, WebKit): the seeded level must match the
 * Node build exactly (NFR-09), and the brand fonts must draw every French character (GAME-14).
 */
import { expect, test } from "@playwright/test";
import golden from "../game-core/golden-digests.json";
import { levelDigest } from "../game-core/level";
import { stcReady } from "./helpers";

test("the same seed builds the same level in the browser and in Node (NFR-09)", async ({
  page,
}) => {
  await page.goto("/?lang=en");
  await stcReady(page);
  const seeds = [...Object.keys(golden.digests).map(Number), 7, 99, 31337, 2 ** 31];
  const inBrowser = await page.evaluate(
    ({ seeds, m }) =>
      seeds.map((s) =>
        (
          window as unknown as { __stc: { levelDigest(s: number, m: number): string } }
        ).__stc.levelDigest(s, m),
      ),
    { seeds, m: golden.distanceM },
  );
  expect(inBrowser).toEqual(seeds.map((s) => levelDigest(s, golden.distanceM)));
  for (const [seed, digest] of Object.entries(golden.digests)) {
    expect(inBrowser[seeds.indexOf(Number(seed))]).toBe(digest);
  }
});

test("the brand fonts draw every French character (GAME-14)", async ({ page }) => {
  await page.goto("/?lang=fr");
  await stcReady(page);
  const result = await page.evaluate(async () => {
    const chars = "éèêëàâçîïôûùœÉÀÇ«»ÈÊÎÔÛŒ’";
    const vars = ["--font-display", "--font-condensed", "--font-body"];
    const root = getComputedStyle(document.documentElement);
    const ctx = document.createElement("canvas").getContext("2d")!;
    const families = vars.map((v) => root.getPropertyValue(v).trim());
    const out: Record<string, string[]> = {};
    for (const [i, list] of families.entries()) {
      // The first entry is the brand font itself; the rest is next/font's fallback list.
      const first = list.split(",")[0].trim();
      await document.fonts.load(`32px ${first}`, chars);
      out[vars[i]] = [...chars].filter((c) => {
        ctx.font = `32px ${first}, serif`;
        const withSerif = ctx.measureText(c).width;
        ctx.font = `32px ${first}, monospace`;
        // A glyph the font lacks is drawn by the fallback, so its advance changes with it.
        return Math.abs(withSerif - ctx.measureText(c).width) > 0.5;
      });
    }
    return { families, out };
  });
  expect(result.families.every((f) => f.length > 0)).toBe(true);
  for (const missing of Object.values(result.out)) expect(missing).toEqual([]);
});
