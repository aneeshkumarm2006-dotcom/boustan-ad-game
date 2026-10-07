import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvForTests } from "./env";
import { DEFAULT_LIMITS, parseLimits, rateLimit, resetMemoryLimitsForTests } from "./rate-limit";

const originalLimits = process.env.RATE_LIMITS;

/** Sets RATE_LIMITS for the rest of the test; afterEach puts the original back. */
function setLimits(value: string) {
  process.env.RATE_LIMITS = value;
  resetEnvForTests();
}

describe("rate limits (SEC-06)", () => {
  beforeEach(() => resetMemoryLimitsForTests());
  afterEach(() => {
    process.env.RATE_LIMITS = originalLimits;
    resetEnvForTests();
    vi.useRealTimers();
  });

  it("has a limit for each thing a visitor could spam, with the PRD's defaults", () => {
    // Whole-object equality, so a limit that is renamed or removed shows up here.
    expect(DEFAULT_LIMITS).toEqual({
      runStart: { limit: 60, windowS: 3600 },
      saveIp: { limit: 5, windowS: 3600 },
      leaderboard: { limit: 120, windowS: 60 },
      adminLogin: { limit: 10, windowS: 3600 },
      events: { limit: 600, windowS: 3600 },
    });
  });

  it("can be overridden by RATE_LIMITS, ignoring junk", () => {
    const rules = parseLimits("saveIp=10/60, nope=1/1, runStart = 120 / 3600, adminLogin=x");
    expect(rules.saveIp).toEqual({ limit: 10, windowS: 60 });
    expect(rules.runStart).toEqual({ limit: 120, windowS: 3600 });
    expect(rules.adminLogin).toEqual(DEFAULT_LIMITS.adminLogin);
    expect(rules).not.toHaveProperty("nope");
  });

  it("uses the defaults when RATE_LIMITS is blank", () => {
    expect(parseLimits(undefined)).toEqual(DEFAULT_LIMITS);
    expect(parseLimits("")).toEqual(DEFAULT_LIMITS);
  });

  it("ignores the names of limits that no longer exist, so an old setting does no harm", () => {
    const old = "claimIp=1/1,claimPlayer=1/1,resendEmail=1/1,resendIp=1/1";
    expect(parseLimits(old)).toEqual(DEFAULT_LIMITS);
  });

  it("allows up to the limit per key, then refuses with a retry time", async () => {
    // tests/setup-env.ts leaves adminLogin at its default.
    const { limit } = DEFAULT_LIMITS.adminLogin;
    for (let i = 0; i < limit; i++) expect((await rateLimit("adminLogin", "k1")).ok).toBe(true);
    const over = await rateLimit("adminLogin", "k1");
    expect(over.ok).toBe(false);
    expect(over.retryAfterS).toBeGreaterThan(3500);
    expect((await rateLimit("adminLogin", "k2")).ok).toBe(true);
  });

  it("counts each limit on its own", async () => {
    setLimits("saveIp=1/60,leaderboard=1/60");
    expect((await rateLimit("saveIp", "k")).ok).toBe(true);
    expect((await rateLimit("saveIp", "k")).ok).toBe(false);
    expect((await rateLimit("leaderboard", "k")).ok).toBe(true);
    expect((await rateLimit("events", "k")).ok).toBe(true);
  });

  it("takes the numbers from RATE_LIMITS", async () => {
    setLimits("saveIp=2/60");
    expect((await rateLimit("saveIp", "ip")).ok).toBe(true);
    expect((await rateLimit("saveIp", "ip")).ok).toBe(true);
    const over = await rateLimit("saveIp", "ip");
    expect(over.ok).toBe(false);
    expect(over.retryAfterS).toBeLessThanOrEqual(60);
  });

  it("frees a slot as the window slides on", async () => {
    setLimits("saveIp=2/60");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    expect((await rateLimit("saveIp", "ip")).ok).toBe(true);
    vi.setSystemTime(new Date("2026-10-15T12:00:20Z"));
    expect((await rateLimit("saveIp", "ip")).ok).toBe(true);

    vi.setSystemTime(new Date("2026-10-15T12:00:30Z"));
    expect(await rateLimit("saveIp", "ip")).toEqual({ ok: false, retryAfterS: 30 });
    // The first hit is more than 60 s old, so one slot is free again. The second is not.
    vi.setSystemTime(new Date("2026-10-15T12:01:01Z"));
    expect((await rateLimit("saveIp", "ip")).ok).toBe(true);
    expect((await rateLimit("saveIp", "ip")).ok).toBe(false);
  });
});
