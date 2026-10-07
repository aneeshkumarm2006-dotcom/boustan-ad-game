import { describe, expect, it } from "vitest";
import { checkEmail, isDisposableDomain } from "./email-address";

describe("checkEmail (SEC-07, DATA-04)", () => {
  it("keeps the address as typed and normalizes for uniqueness", () => {
    expect(checkEmail("  Alex.Tremblay+jeu@Gmail.com ")).toEqual({
      ok: true,
      email: "Alex.Tremblay+jeu@Gmail.com",
      normalized: "alextremblay@gmail.com",
    });
  });

  it("gives one player's addresses one key, so one person is one row on the board", () => {
    const key = (email: string) => {
      const checked = checkEmail(email);
      return checked.ok ? checked.normalized : checked.reason;
    };
    expect(key("sam.roy@gmail.com")).toBe("samroy@gmail.com");
    expect(key("SamRoy+contest@googlemail.com")).toBe("samroy@gmail.com");
    expect(key("S.A.M.R.O.Y@GMAIL.COM")).toBe("samroy@gmail.com");
    // Dots matter outside Gmail, but plus tags and capitals don't.
    expect(key("sam.roy@videotron.ca")).toBe("sam.roy@videotron.ca");
    expect(key("Sam.Roy+x@Videotron.ca")).toBe("sam.roy@videotron.ca");
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
