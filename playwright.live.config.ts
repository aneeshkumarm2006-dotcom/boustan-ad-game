import { defineConfig, devices } from "@playwright/test";

/**
 * End to end against the real API and a real MongoDB (Stage 2 "done when"): a claim with a
 * test pool, the sandboxed email, unsubscribe, and a forged run. Needs a replica set:
 * LIVE_MONGODB_URI, or `npm run db:local` running (a separate boustan_e2e database is used).
 *
 *   npm run test:e2e:live
 *
 * Turnstile uses Cloudflare's always-pass test keys, so the browser needs network access.
 */
const PORT = 3300;
export const LIVE_MONGODB_URI =
  process.env.LIVE_MONGODB_URI ??
  "mongodb://127.0.0.1:27019/boustan_e2e?replicaSet=rs0&directConnection=true";

export default defineConfig({
  testDir: "./e2e-live",
  globalSetup: "./e2e-live/global-setup.ts",
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "live", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run dev -- -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      NEXT_PUBLIC_API_MODE: "live",
      // Set LIVE_APP_MONGODB_URI to run the server as the least-privilege user (db/roles.ts).
      MONGODB_URI: process.env.LIVE_APP_MONGODB_URI ?? LIVE_MONGODB_URI,
      RUN_TOKEN_SECRET: "e2e-live-secret-e2e-live-secret-e2e-live-secret",
      APP_URL: `http://localhost:${PORT}`,
      EMAIL_SANDBOX: "1",
      EMAIL_API_KEY: "",
      TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000BB",
      UPSTASH_REDIS_REST_URL: "",
      STC_TEST_HOOKS: "1",
      ALLOWED_HOSTS: "http://127.0.0.1:3200",
    },
  },
});
