import { describe, expect, it } from "vitest";
import { deviceOf, montrealDay, montrealDayStart } from "./analytics";

describe("Montréal calendar days (AN-02)", () => {
  it("names the local date, either side of midnight, in winter and in summer", () => {
    expect(montrealDay(0, Date.parse("2026-01-15T04:59:59Z"))).toBe("2026-01-14");
    expect(montrealDay(0, Date.parse("2026-01-15T05:00:00Z"))).toBe("2026-01-15");
    expect(montrealDay(0, Date.parse("2026-07-15T03:59:59Z"))).toBe("2026-07-14");
    expect(montrealDay(0, Date.parse("2026-07-15T04:00:00Z"))).toBe("2026-07-15");
  });

  it("counts days back from now", () => {
    expect(montrealDay(1, Date.parse("2026-01-15T12:00:00Z"))).toBe("2026-01-14");
    expect(montrealDay(3, Date.parse("2026-01-15T12:00:00Z"))).toBe("2026-01-12");
  });

  it("starts a day at midnight Montréal time, across the daylight saving changes", () => {
    const start = (day: string) => montrealDayStart(day).toISOString();
    expect(start("2026-01-15")).toBe("2026-01-15T05:00:00.000Z");
    expect(start("2026-07-15")).toBe("2026-07-15T04:00:00.000Z");
    // Spring forward is at 2 a.m. on Mar 8 2026, and fall back at 2 a.m. on Nov 1.
    expect(start("2026-03-08")).toBe("2026-03-08T05:00:00.000Z");
    expect(start("2026-03-09")).toBe("2026-03-09T04:00:00.000Z");
    expect(start("2026-11-01")).toBe("2026-11-01T04:00:00.000Z");
    expect(start("2026-11-02")).toBe("2026-11-02T05:00:00.000Z");
  });

  it("refuses something that isn't a calendar day", () => {
    for (const bad of ["", "nope", "2026-13-01", "2026-02-30"]) {
      expect(() => montrealDayStart(bad), bad).toThrow("Not a calendar day");
    }
  });
});

describe("device class (ADM-02)", () => {
  it("is coarse: mobile, tablet or desktop, and nothing when there is no user agent", () => {
    expect(deviceOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148")).toBe(
      "mobile",
    );
    expect(deviceOf("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe("tablet");
    expect(deviceOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126")).toBe("desktop");
    expect(deviceOf(null)).toBeNull();
  });
});
