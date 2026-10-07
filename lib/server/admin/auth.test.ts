import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvForTests } from "../env";
import { resetMemoryLimitsForTests } from "../rate-limit";
import { adminPasswordStamp, signToken } from "../tokens";
import {
  ADMIN_NAME,
  SESSION_COOKIE,
  adminFromRequest,
  adminFromSession,
  signInWithPassword,
} from "./auth";

const PASSWORD = "correct horse battery";

beforeEach(() => {
  process.env.ADMIN_PASSWORD = PASSWORD;
  resetEnvForTests();
  resetMemoryLimitsForTests();
});
afterEach(() => {
  delete process.env.ADMIN_PASSWORD;
  resetEnvForTests();
});

/** A session token exactly as signInWithPassword builds one, with a chosen expiry. */
const sessionFor = (password: string, exp: number) =>
  signToken("admin_session", { v: 1, p: adminPasswordStamp(password), exp });

describe("admin sign-in (ADM-01)", () => {
  it("gives a session for the right password, ignoring spaces around it", async () => {
    const res = await signInWithPassword(`  ${PASSWORD} `, "198.51.100.1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(adminFromSession(res.session)).toBe(ADMIN_NAME);
  });

  it("refuses a wrong, empty or oversized password", async () => {
    for (const bad of ["nope", "", PASSWORD.toUpperCase(), "x".repeat(5000)]) {
      expect(await signInWithPassword(bad, "198.51.100.2")).toEqual({ ok: false, reason: "wrong" });
    }
  });

  it("lets nobody in while ADMIN_PASSWORD is blank", async () => {
    process.env.ADMIN_PASSWORD = "   ";
    resetEnvForTests();
    expect(await signInWithPassword("   ", null)).toEqual({ ok: false, reason: "not_configured" });
    expect(await signInWithPassword("", null)).toEqual({ ok: false, reason: "not_configured" });
    expect(adminFromSession(sessionFor("", Date.now() + 60_000))).toBeNull();
  });

  it("limits attempts per IP, and the limit applies to the right password too", async () => {
    let limited = false;
    for (let i = 0; i < 12; i++) {
      const res = await signInWithPassword("guess", "198.51.100.5");
      if (!res.ok && res.reason === "rate_limited") limited = true;
    }
    expect(limited).toBe(true);
    expect(await signInWithPassword(PASSWORD, "198.51.100.5")).toEqual({
      ok: false,
      reason: "rate_limited",
    });
    // Another address is not affected.
    expect((await signInWithPassword(PASSWORD, "198.51.100.6")).ok).toBe(true);
  });
});

describe("admin session", () => {
  it("ends on expiry", () => {
    const now = Date.now();
    const live = sessionFor(PASSWORD, now + 1000);
    expect(adminFromSession(live, now)).toBe(ADMIN_NAME);
    expect(adminFromSession(live, now + 2000)).toBeNull();
    expect(adminFromSession(undefined)).toBeNull();
    expect(adminFromSession("abc.def")).toBeNull();
  });

  it("ends when the password changes", () => {
    const live = sessionFor(PASSWORD, Date.now() + 60_000);
    expect(adminFromSession(live)).toBe(ADMIN_NAME);
    process.env.ADMIN_PASSWORD = "a different password";
    resetEnvForTests();
    expect(adminFromSession(live)).toBeNull();
  });

  it("refuses a token for the wrong password and one signed as another kind", () => {
    const now = Date.now();
    expect(adminFromSession(sessionFor("someone else's", now + 60_000))).toBeNull();
    const asRun = signToken("run", { v: 1, p: adminPasswordStamp(PASSWORD), exp: now + 60_000 });
    expect(adminFromSession(asRun)).toBeNull();
    const save = signToken("save", {
      v: 1,
      run: "00000000-0000-4000-8000-000000000000",
      exp: now + 1e6,
    });
    expect(adminFromSession(save)).toBeNull();
  });

  it("is not the password and does not contain it", async () => {
    const res = await signInWithPassword(PASSWORD, null);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const body = Buffer.from(res.session.split(".")[0], "base64url").toString("utf8");
    expect(body).not.toContain(PASSWORD);
    expect(res.session).not.toContain(PASSWORD);
  });

  it("is read from a request's cookie header", () => {
    const token = sessionFor(PASSWORD, Date.now() + 60_000);
    const req = (cookie: string) =>
      new Request("https://game.test/api/admin/x", { headers: { cookie } });
    expect(adminFromRequest(req(`a=1; ${SESSION_COOKIE}=${encodeURIComponent(token)}; b=2`))).toBe(
      ADMIN_NAME,
    );
    expect(adminFromRequest(req("a=1"))).toBeNull();
    expect(adminFromRequest(req(`${SESSION_COOKIE}=garbage`))).toBeNull();
    expect(adminFromRequest(new Request("https://game.test/"))).toBeNull();
  });
});
