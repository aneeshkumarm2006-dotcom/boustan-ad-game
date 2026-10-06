import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, parseLimits, rateLimit, resetMemoryLimitsForTests } from "./rate-limit";

describe("rate limits (SEC-06)", () => {
  beforeEach(() => resetMemoryLimitsForTests());

  it("defaults follow the PRD", () => {
    expect(DEFAULT_LIMITS.runStart).toEqual({ limit: 60, windowS: 3600 });
    expect(DEFAULT_LIMITS.claimIp).toEqual({ limit: 5, windowS: 3600 });
    expect(DEFAULT_LIMITS.claimPlayer).toEqual({ limit: 3, windowS: 86_400 });
    expect(DEFAULT_LIMITS.resendEmail).toEqual({ limit: 3, windowS: 3600 });
  });

  it("can be overridden by RATE_LIMITS, ignoring junk", () => {
    const rules = parseLimits("claimIp=10/60, nope=1/1, runStart = 120 / 3600, resendEmail=x");
    expect(rules.claimIp).toEqual({ limit: 10, windowS: 60 });
    expect(rules.runStart).toEqual({ limit: 120, windowS: 3600 });
    expect(rules.resendEmail).toEqual(DEFAULT_LIMITS.resendEmail);
  });

  it("allows up to the limit per key, then refuses with a retry time", async () => {
    // tests/setup-env.ts sets resendEmail to 3 per hour.
    for (let i = 0; i < 3; i++) expect((await rateLimit("resendEmail", "k1")).ok).toBe(true);
    const over = await rateLimit("resendEmail", "k1");
    expect(over.ok).toBe(false);
    expect(over.retryAfterS).toBeGreaterThan(3500);
    expect((await rateLimit("resendEmail", "k2")).ok).toBe(true);
  });
});
