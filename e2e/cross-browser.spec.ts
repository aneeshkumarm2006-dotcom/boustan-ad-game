/**
 * Runs in every browser project (Chromium, Firefox, WebKit): the seeded level must match the
 * Node build exactly (NFR-09), and the pixel fonts must draw every French character (GAME-14).
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

test("the pixel fonts draw every French character (GAME-14)", async ({ page }) => {
  await page.goto("/?lang=fr");
  await stcReady(page);
  await page.evaluate(() => document.fonts.ready);
  const result = await page.evaluate(() => {
    const chars = "éèêëàâçîïôûùœÉÀÇ«»ÈÊÎÔÛŒ’";
    const families = ["--font-pixel", "--font-mono"].map((v) =>
      getComputedStyle(document.documentElement).getPropertyValue(v).trim(),
    );
    const ctx = document.createElement("canvas").getContext("2d")!;
    const out: Record<string, string[]> = {};
    for (const family of families) {
      // Both fonts are monospaced: a glyph from a fallback font would change the advance.
      ctx.font = `32px ${family}`;
      const em = ctx.measureText("M").width;
      out[family] = [...chars].filter((c) => Math.abs(ctx.measureText(c).width - em) > 0.5);
    }
    return { families, out };
  });
  expect(result.families.every((f) => f.length > 0)).toBe(true);
  for (const missing of Object.values(result.out)) expect(missing).toEqual([]);
});
