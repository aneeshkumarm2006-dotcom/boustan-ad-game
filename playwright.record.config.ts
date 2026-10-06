import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

/**
 * Records real runs through window.__stc for the validator tests (NFR-09, AC-05):
 * `npm run record:runs` rewrites game-core/fixtures/recorded-runs.json. Re-record after a
 * tuning change that alters levels (bump TUNING.version first).
 */
export default defineConfig({
  ...base,
  testDir: "./e2e-record",
  workers: 1,
  retries: 0,
  projects: [{ name: "record", use: { ...devices["Desktop Chrome"] } }],
});
