import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
const HOST_PORTS = "3200,3201";
const baseURL = `http://localhost:${PORT}`;
const isCI = Boolean(process.env.CI);
/** Production build: CI, or E2E_PROD=1 locally (needed for the size and speed budgets). */
const prod = isCI || process.env.E2E_PROD === "1";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [["github"], ["html", { open: "never" }]] : "list",
  timeout: 60_000,
  // Runs simulate 30 s of play on a fake clock; more workers starve the CPU and flake.
  workers: 2,
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
      testIgnore: /(cross-browser|budget).spec.ts$/,
    },
    // Seeded levels and French glyphs must match in every engine (NFR-09, GAME-14).
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
      testMatch: /cross-browser.spec.ts$/,
    },
    { name: "webkit", use: { ...devices["iPhone 13"] }, testMatch: /cross-browser.spec.ts$/ },
    // iPhone Safari emulation for the main flows (AC-01). Real devices are Stage 4.
    {
      name: "mobile-webkit",
      use: { ...devices["iPhone 13"] },
      testMatch: /(game|embed|layout).spec.ts$/,
    },
  ],
  webServer: [
    {
      command: prod ? `npm run build && npm run start -- -p ${PORT}` : `npm run dev -- -p ${PORT}`,
      url: baseURL,
      reuseExistingServer: !isCI,
      timeout: 180_000,
      env: {
        // Only the first test host may embed; the second checks that others are blocked (AC-12).
        ALLOWED_HOSTS: "http://127.0.0.1:3200",
        STC_TEST_HOOKS: "1",
        // This suite runs on the in-browser mock, even if .env.local says live.
        NEXT_PUBLIC_API_MODE: "mock",
      },
    },
    {
      command: "node e2e/host/server.mjs",
      url: "http://127.0.0.1:3200/",
      reuseExistingServer: !isCI,
      env: { HOST_PORTS },
    },
  ],
});
