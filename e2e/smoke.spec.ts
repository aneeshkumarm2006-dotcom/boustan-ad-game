import { expect, test } from "@playwright/test";
import { stcReady, watchConsole } from "./helpers";

test("home page renders the start screen in French for a French browser", async ({ browser }) => {
  const context = await browser.newContext({ locale: "fr-CA" });
  const fresh = await context.newPage();
  const errors = watchConsole(fresh);
  const response = await fresh.goto("/");
  expect(response?.ok()).toBe(true);
  await expect(fresh.getByRole("heading", { level: 1 })).toContainText("Sauvez le");
  await expect(fresh.getByTestId("play")).toHaveText("COURS, POULET, COURS");
  await stcReady(fresh);
  expect(errors).toEqual([]);
  await context.close();
});

test("any other browser language gets English; ?lang wins (L10N-02)", async ({ browser }) => {
  const context = await browser.newContext({ locale: "de-DE" });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByTestId("play")).toHaveText("RUN, CHICKEN, RUN");
  // The saved choice beats the browser language...
  await page.getByRole("dialog").getByRole("button", { name: "FR", exact: true }).click();
  await page.goto("/");
  await expect(page.getByTestId("play")).toHaveText("COURS, POULET, COURS");
  // ...and ?lang beats the saved choice.
  await page.goto("/?lang=en");
  await expect(page.getByTestId("play")).toHaveText("RUN, CHICKEN, RUN");
  await context.close();
});

test("sets no cookies (EMB-07)", async ({ page, context }) => {
  await page.goto("/");
  await stcReady(page);
  expect(await context.cookies()).toEqual([]);
});

test("declares the brand theme colour and a social preview", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#073F36");
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    /opengraph-image/,
  );
  await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute("content", "1200");
  expect((await page.request.get("/opengraph-image.png")).headers()["content-type"]).toBe(
    "image/png",
  );
});

test("an unknown URL gets the branded 404 in both languages", async ({ page }) => {
  const response = await page.goto("/no-such-page");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("img", { name: "Boustan" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Page introuvable" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Retour au jeu" })).toHaveAttribute(
    "href",
    "/?lang=fr",
  );
  await expect(page.getByRole("link", { name: "Back to the game" })).toHaveAttribute(
    "href",
    "/?lang=en",
  );
});
