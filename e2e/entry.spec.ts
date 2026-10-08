import { expect, test } from "@playwright/test";
import { advance, scoreAndDie, stcReady, snapshot } from "./helpers";

test("entry required, explicit save and retry without re-entering details", async ({
  page,
}, testInfo) => {
  await page.clock.install();
  await page.goto("/?lang=en");
  await stcReady(page);
  await expect(page.getByTestId("scoring")).toContainText("BOUSTAN GIFT CARDS");
  await page.getByTestId("play").click();
  await expect(page.getByText("Enter a valid email address.")).toBeVisible();
  await page.getByLabel("Your email", { exact: true }).fill("entry.player@gmail.com");
  await page.getByLabel("Username", { exact: true }).fill("Entry Player");
  await page.locator('input[type="checkbox"]').first().check();
  await page.screenshot({ path: testInfo.outputPath("entry-screen.png"), fullPage: true });
  await page.getByTestId("play").click();
  await advance(page, 600);
  await expect.poll(async () => (await snapshot(page)).state).toBe("play");
  await scoreAndDie(page);
  await expect(page.locator('input[type="email"]')).toHaveCount(0);
  await expect(page.getByTestId("save")).toBeVisible();
  await expect(page.getByRole("button", { name: "TRY AGAIN", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("results-screen.png"), fullPage: true });
  await page.getByTestId("save").click();
  await advance(page, 500);
  await expect(page.getByTestId("saved")).toBeVisible();
  await page.getByRole("button", { name: "TRY AGAIN", exact: true }).click();
  await advance(page, 500);
  await scoreAndDie(page);
  await expect(page.getByTestId("save")).toBeVisible();
  await expect(page.locator('input[type="email"]')).toHaveCount(0);
});
