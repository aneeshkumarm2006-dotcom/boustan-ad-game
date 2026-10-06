import { expect, test } from "@playwright/test";
import { stcReady, watchConsole } from "./helpers";

test("home page renders the start screen in French for a French browser", async ({ browser }) => {
  const context = await browser.newContext({ locale: "fr-CA" });
  const fresh = await context.newPage();
  const errors = watchConsole(fresh);
  const response = await fresh.goto("/");
  expect(response?.ok()).toBe(true);
  await expect(fresh.getByRole("heading", { level: 1 })).toContainText("SAUVEZ LE");
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
