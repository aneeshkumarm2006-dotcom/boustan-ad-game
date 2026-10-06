import { describe, expect, it } from "vitest";
import { formatMontreal, parseMontrealLocal, toMontrealLocal } from "./time";

describe("Montréal wall-clock dates", () => {
  it("reads summer time as UTC-4 and winter time as UTC-5", () => {
    expect(parseMontrealLocal("2026-10-15T00:00")?.toISOString()).toBe("2026-10-15T04:00:00.000Z");
    expect(parseMontrealLocal("2026-11-15T00:00")?.toISOString()).toBe("2026-11-15T05:00:00.000Z");
  });
  it("takes a bare date as the start of that day", () => {
    expect(parseMontrealLocal("2026-10-15")?.toISOString()).toBe("2026-10-15T04:00:00.000Z");
  });
  it("handles the spring and fall clock changes", () => {
    expect(parseMontrealLocal("2026-03-08T03:30")?.toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(parseMontrealLocal("2026-11-01T03:00")?.toISOString()).toBe("2026-11-01T08:00:00.000Z");
  });
  it("rejects what isn't a real date, or a time that doesn't exist", () => {
    expect(parseMontrealLocal("nope")).toBeNull();
    expect(parseMontrealLocal("2026-02-30T10:00")).toBeNull();
    expect(parseMontrealLocal("2026-03-08T02:30")).toBeNull();
  });
  it("round-trips for form fields and tables", () => {
    const d = parseMontrealLocal("2026-10-15T09:05")!;
    expect(toMontrealLocal(d)).toBe("2026-10-15T09:05");
    expect(formatMontreal(d)).toBe("2026-10-15 09:05");
    expect(toMontrealLocal(null)).toBe("");
    expect(formatMontreal(null)).toBe("—");
  });
});
