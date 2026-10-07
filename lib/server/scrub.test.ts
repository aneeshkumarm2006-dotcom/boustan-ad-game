import { describe, expect, it } from "vitest";
import { scrub } from "./scrub";

describe("scrub (NFR-08)", () => {
  it("masks anything email-like before text reaches a log or Sentry", () => {
    expect(scrub("E11000 duplicate key: { emailNormalized: jo@videotron.ca }")).toBe(
      "E11000 duplicate key: { emailNormalized: [email] }",
    );
    expect(scrub("a@b.ca and c.d+e@f.org")).toBe("[email] and [email]");
    expect(scrub('invalid "to": <marie@sympatico.ca>')).toBe('invalid "to": <[email]>');
  });

  it("leaves other text alone", () => {
    expect(scrub("connection refused")).toBe("connection refused");
    expect(scrub("rank @ 3")).toBe("rank @ 3");
  });

  it("caps the length at 300 characters", () => {
    expect(scrub("x".repeat(1000))).toHaveLength(300);
  });
});
