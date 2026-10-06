import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { advance, cheat, die, play, setHeat, snapshot, stcReady } from "../e2e/helpers";

interface Recorded {
  scenario: string;
  seed: number;
  distance: number;
  garlic: number;
  hits: number;
  activeMs: number;
}

interface Scenario {
  name: string;
  seconds: number;
  cheat?: { invincible?: boolean; magnet?: boolean };
  /** Reset the spit heat every second so hits pile up without dying. */
  keepAlive?: boolean;
  /** Jump this often (seconds), like a player mashing the button. */
  jumpEvery?: number;
}

const SCENARIOS: Scenario[] = [
  { name: "idle", seconds: 0 },
  { name: "survive", seconds: 40, keepAlive: true },
  { name: "jumper", seconds: 35, keepAlive: true, jumpEvery: 0.45 },
  { name: "magnet", seconds: 30, cheat: { invincible: true, magnet: true } },
  { name: "magnet_long", seconds: 80, cheat: { invincible: true, magnet: true } },
  { name: "magnet_hits", seconds: 45, cheat: { magnet: true }, keepAlive: true },
];
const REPEATS = 3;

interface Hooks {
  jump(): void;
  run(seconds: number): void;
  result(): { seed: number; distanceM: number; garlic: number; hits: number; activeMs: number };
}
/** Steps the game in small slices so heat resets and jumps happen during the run. */
async function runFor(page: Page, s: Scenario): Promise<void> {
  const step = s.jumpEvery ?? 1;
  for (let t = 0; t < s.seconds; t += step) {
    if (s.jumpEvery)
      await page.evaluate(() => (window as unknown as { __stc: Hooks }).__stc.jump());
    await page.evaluate((dt) => (window as unknown as { __stc: Hooks }).__stc.run(dt), step);
    await page.clock.fastForward(Math.round(step * 1000));
    if (s.keepAlive) await setHeat(page, 0);
  }
}

test("record honest runs for the validator tests", async ({ page }) => {
  test.setTimeout(600_000);
  await page.clock.install();
  const recorded: Recorded[] = [];
  for (const s of SCENARIOS) {
    for (let i = 0; i < REPEATS; i++) {
      await page.goto("/?lang=en");
      await stcReady(page);
      await play(page);
      if (s.cheat) await cheat(page, s.cheat);
      if (s.seconds === 0) {
        // No input at all: the chicken runs into things until the spit catches it.
        for (let t = 0; t < 120 && (await snapshot(page)).state !== "over"; t++) {
          await runFor(page, { name: s.name, seconds: 1 });
        }
        await advance(page, 500);
      } else {
        await runFor(page, s);
        await die(page);
      }
      // The mock API runs the same validator: the run must not be flagged.
      await expect(page.getByRole("heading", { name: "REST IN PITA" })).toBeVisible();
      await expect(page.getByText("Checking your run…")).toHaveCount(0);
      await expect(page.getByText("We couldn't verify this run.")).toHaveCount(0);
      const result = await page.evaluate(() =>
        (window as unknown as { __stc: Hooks }).__stc.result(),
      );
      recorded.push({
        scenario: s.name,
        seed: result.seed,
        distance: result.distanceM,
        garlic: result.garlic,
        hits: result.hits,
        activeMs: result.activeMs,
      });
    }
  }
  const out = path.resolve("game-core/fixtures/recorded-runs.json");
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        comment:
          "Runs played in Chromium through window.__stc (npm run record:runs). The validator must accept every one (NFR-09, AC-05).",
        runs: recorded,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Recorded ${recorded.length} runs to ${out}`);
});
