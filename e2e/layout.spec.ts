/**
 * French text runs ~30% longer than English; every screen must hold up at the smallest embed
 * size, 300 × 400 (L10N-05, EMB-01).
 */
import { expect, test, type Page } from "@playwright/test";
import { advance, cheat, die, play, simulate, stcReady } from "./helpers";

test.use({ viewport: { width: 300, height: 400 } });

async function noHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => {
    const offenders: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(".card *, .bar *, .hud *")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1)) {
        offenders.push(`${el.tagName}.${el.className}: ${el.textContent?.slice(0, 30)}`);
      }
      const text = el.textContent?.trim() ?? "";
      if (
        text &&
        el.scrollWidth > el.clientWidth + 1 &&
        getComputedStyle(el).overflowX === "visible"
      ) {
        if (el.matches("button, a, p, h1, h2, h3, span, label, td, th"))
          offenders.push(`clipped ${el.tagName}: ${el.textContent?.slice(0, 30)}`);
      }
    }
    return { page: document.documentElement.scrollWidth > window.innerWidth, offenders };
  });
  expect(overflow, label).toEqual({ page: false, offenders: [] });
}

for (const lang of ["fr", "en"]) {
  test(`every screen fits 300 × 400 in ${lang}`, async ({ page }) => {
    await page.clock.install();
    await page.goto(`/?lang=${lang}`);
    await stcReady(page);
    await advance(page, 300);
    await noHorizontalOverflow(page, "start");

    await page.locator(".card .btn.ghost").first().click(); // leaderboard
    await advance(page, 300);
    await noHorizontalOverflow(page, "leaderboard");
    await page.locator(".card .linkish").first().click();

    await play(page);
    await advance(page, 1000);
    await noHorizontalOverflow(page, "hud");
    // A long run, so the HUD holds a four-digit score (grouped in French: "1 150").
    await cheat(page, { invincible: true, magnet: true });
    await simulate(page, page, 90);
    await noHorizontalOverflow(page, "hud, long run");
    await die(page);
    await noHorizontalOverflow(page, "results");

    await noHorizontalOverflow(page, "save");
    await page.locator('.card input[type="email"]').fill("long.name.for.layout@example.com");
    await page.locator('.card input[type="checkbox"]').first().check();
    await page.locator('.card button[type="submit"]').click();
    await advance(page, 500);
    await expect(page.getByTestId("saved")).toBeVisible();
    await noHorizontalOverflow(page, "saved");

    await page.getByRole("button", { name: lang === "fr" ? "CLASSEMENT" : "LEADERBOARD" }).click();
    await advance(page, 300);
    await expect(page.locator(".board tr.me")).toHaveCount(1);
    await noHorizontalOverflow(page, "leaderboard, own row");
  });

  test(`the closed-contest note fits 300 × 400 in ${lang}`, async ({ page }) => {
    await page.goto(`/?lang=${lang}&mock=not_started`);
    await stcReady(page);
    await expect(page.locator(".campaign-note")).toBeVisible();
    await noHorizontalOverflow(page, "start, not started");
  });
}
