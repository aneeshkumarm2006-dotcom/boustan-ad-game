import { describe, expect, it } from "vitest";
import { checkEmail, isDisposableDomain } from "./email-address";

describe("checkEmail (RWD-05, DATA-04)", () => {
  it("keeps the address as typed and normalizes for uniqueness", () => {
    expect(checkEmail("  Alex.Tremblay+jeu@Gmail.com ")).toEqual({
      ok: true,
      email: "Alex.Tremblay+jeu@Gmail.com",
      normalized: "alextremblay@gmail.com",
    });
  });

  it("accepts any real provider", () => {
    for (const e of ["jo@videotron.ca", "a@b.co", "marie-eve@sympatico.ca", "x@outlook.com"]) {
      expect(checkEmail(e).ok).toBe(true);
    }
  });

  it("rejects accented local parts, which most mailboxes and providers can't take", () => {
    expect(checkEmail("marie-ève@sympatico.ca")).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects malformed addresses", () => {
    for (const e of ["", "nobody", "a@b", "a b@c.ca", "@x.ca", `${"a".repeat(65)}@x.ca`]) {
      expect(checkEmail(e)).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("rejects disposable domains, including their subdomains", () => {
    expect(checkEmail("x@mailinator.com")).toEqual({ ok: false, reason: "disposable" });
    expect(checkEmail("x@YOPMAIL.com")).toEqual({ ok: false, reason: "disposable" });
    expect(isDisposableDomain("inbox.guerrillamail.com")).toBe(true);
    expect(isDisposableDomain("gmail.com")).toBe(false);
    expect(isDisposableDomain("boustan.ca")).toBe(false);
  });
});
