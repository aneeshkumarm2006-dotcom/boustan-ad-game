/**
 * Load and speed budgets (EMB-11, GAME-15, AC-10). Only meaningful on a production build:
 * run with E2E_PROD=1 (CI does). Chromium only, since it uses DevTools throttling.
 */
import { expect, test } from "@playwright/test";

const prod = Boolean(process.env.CI) || process.env.E2E_PROD === "1";
test.skip(!prod, "budgets need a production build (E2E_PROD=1)");
// Timing tests share one CPU badly; run them one at a time.
test.describe.configure({ mode: "serial" });

const KB = 1024;

test("first load is 250 KB or less gzipped (EMB-11)", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  let bytes = 0;
  const sizes: Record<string, number> = {};
  const urls = new Map<string, string>();
  cdp.on("Network.responseReceived", (e) => urls.set(e.requestId, e.response.url));
  cdp.on("Network.loadingFinished", (e) => {
    bytes += e.encodedDataLength;
    const url = urls.get(e.requestId) ?? e.requestId;
    sizes[url.replace(/^https?:\/\/[^/]+/, "")] = Math.round(e.encodedDataLength / 102.4) / 10;
  });
  await page.goto("/?lang=fr", { waitUntil: "networkidle" });
  await page.waitForFunction(() => "__stc" in window);
  console.log(`first load: ${(bytes / KB).toFixed(1)} KB`, sizes);
  expect(bytes).toBeLessThanOrEqual(250 * KB);
});

/**
 * Median time from navigation start to the first playable frame (the "boustan:playable" mark)
 * over the given network, with the CPU slowed 4× like a mid-range phone. Median of 3 loads,
 * since a shared CI machine is noisy.
 */
async function timeToPlayable(
  page: import("@playwright/test").Page,
  net: { latency: number; downMbps: number; upMbps: number },
): Promise<number> {
  const runs: number[] = [];
  for (let i = 0; i < 3; i++) runs.push(await loadOnce(page, net));
  return runs.sort((a, b) => a - b)[1];
}

async function loadOnce(
  page: import("@playwright/test").Page,
  net: { latency: number; downMbps: number; upMbps: number },
): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: net.latency,
    downloadThroughput: (net.downMbps * 1024 * 1024) / 8,
    uploadThroughput: (net.upMbps * 1024 * 1024) / 8,
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.goto("/?lang=fr", { waitUntil: "commit" });
  await page.getByTestId("play").and(page.locator(":enabled")).waitFor();
  // Measured in the page from navigation start, so test-runner overhead doesn't count.
  const ms = await page.evaluate(() =>
    Math.round(performance.getEntriesByName("boustan:playable")[0]?.startTime ?? Infinity),
  );
  await cdp.detach();
  return ms;
}

test("first playable frame under 2 s on 4G (EMB-11)", async ({ page }) => {
  // WebPageTest's "4G" profile: 9 Mbps both ways, 170 ms RTT.
  const ms = await timeToPlayable(page, { latency: 170, downMbps: 9, upMbps: 9 });
  console.log(`first playable frame, 4G: ${ms} ms`);
  // Shared CI runners are slower and noisier than a phone; there the check only catches
  // regressions. Real devices are measured in Stage 4.
  expect(ms).toBeLessThan(process.env.CI ? 4000 : 2000);
});

test("first playable frame on Lighthouse's Slow 4G (reported, Stage 4 target)", async ({
  page,
}) => {
  // DevTools "Slow 4G", as Lighthouse mobile uses: 1.6 Mbps down, 750 kbps up, 150 ms RTT.
  const ms = await timeToPlayable(page, { latency: 150, downMbps: 1.6, upMbps: 0.75 });
  console.log(`first playable frame, Slow 4G: ${ms} ms`);
  expect(ms).toBeLessThan(process.env.CI ? 6000 : 3000);
});

test("holds 30+ fps with the CPU slowed to a 2020 mid-range phone (GAME-15)", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await page.goto("/?lang=fr");
  await page.waitForFunction(() => "__stc" in window);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  await page.evaluate(async () => {
    const stc = (window as unknown as { __stc: { start(): Promise<void>; cheat(c: object): void } })
      .__stc;
    await stc.start();
    stc.cheat({ invincible: true, magnet: true });
  });
  const fps = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let frames = 0;
        const t0 = performance.now();
        const tick = () => {
          frames++;
          if (performance.now() - t0 < 5000) requestAnimationFrame(tick);
          else resolve((frames * 1000) / (performance.now() - t0));
        };
        requestAnimationFrame(tick);
      }),
  );
  console.log(`fps at 6× CPU slowdown: ${fps.toFixed(1)}`);
  expect(fps).toBeGreaterThanOrEqual(30);
});
