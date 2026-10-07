import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvForTests } from "../env";
import { resetMemoryLimitsForTests } from "../rate-limit";
import type { OutgoingEmail } from "../email/sender";
import { signToken } from "../tokens";
import {
  SESSION_COOKIE,
  adminFromRequest,
  adminFromSession,
  requestLoginLink,
  sessionFromLoginToken,
} from "./auth";

const sent: OutgoingEmail[] = [];
const send = async (e: OutgoingEmail) => {
  sent.push(e);
  return { id: "x" };
};

beforeEach(() => {
  sent.length = 0;
  process.env.ADMIN_EMAILS = "Boss@Boustan.test, ops@boustan.test";
  process.env.ADMIN_DEV_LINK = "";
  resetEnvForTests();
  resetMemoryLimitsForTests();
});
afterEach(() => {
  delete process.env.ADMIN_EMAILS;
  delete process.env.ADMIN_DEV_LINK;
  resetEnvForTests();
});

const tokenOf = (link: string) => new URL(link).searchParams.get("t")!;

describe("admin sign-in (ADM-01)", () => {
  it("emails a link to a listed address, whatever the case", async () => {
    const res = await requestLoginLink("  BOSS@boustan.test ", "198.51.100.1", send);
    expect(res).toEqual({ ok: true, devLink: undefined });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("boss@boustan.test");
    expect(sent[0].text).toContain("/admin/verify?t=");
    expect(sent[0].html).toContain("/admin/verify?t=");
  });

  it("sends nothing to an address that isn't listed, and answers the same", async () => {
    const res = await requestLoginLink("stranger@example.com", "198.51.100.1", send);
    expect(res).toEqual({ ok: true });
    expect(sent).toEqual([]);
  });

  it("returns the link on the page only with ADMIN_DEV_LINK=1, and only for listed addresses", async () => {
    process.env.ADMIN_DEV_LINK = "1";
    resetEnvForTests();
    const listed = await requestLoginLink("ops@boustan.test", null, send);
    expect(listed.ok && listed.devLink).toContain("/admin/verify?t=");
    const unlisted = await requestLoginLink("x@example.com", null, send);
    expect(unlisted.ok && unlisted.devLink).toBeUndefined();
  });

  it("limits sign-in links per address and per IP", async () => {
    let limited = false;
    for (let i = 0; i < 12; i++) {
      const res = await requestLoginLink("boss@boustan.test", "198.51.100.5", send);
      if (!res.ok) limited = true;
    }
    expect(limited).toBe(true);
    expect(sent.length).toBeLessThanOrEqual(10);
  });

  it("turns a fresh link into a session for that admin", async () => {
    await requestLoginLink("boss@boustan.test", null, send);
    const link = /https?:\/\/\S+\/admin\/verify\?t=[^\s"<]+/.exec(sent[0].text)![0];
    const session = sessionFromLoginToken(decodeURIComponent(tokenOf(link)));
    expect(session).not.toBeNull();
    expect(adminFromSession(session!)).toBe("boss@boustan.test");
  });

  it("refuses an expired link, a forged one, and one for an address since removed", () => {
    const now = Date.now();
    const old = signToken("admin_login", { v: 1, e: "boss@boustan.test", exp: now - 1 });
    expect(sessionFromLoginToken(old, now)).toBeNull();
    expect(sessionFromLoginToken("abc.def", now)).toBeNull();
    const stranger = signToken("admin_login", { v: 1, e: "x@example.com", exp: now + 60_000 });
    expect(sessionFromLoginToken(stranger, now)).toBeNull();
  });

  it("does not accept one kind of token as another", () => {
    const now = Date.now();
    const asSession = signToken("admin_session", { v: 1, e: "boss@boustan.test", exp: now + 1e6 });
    expect(sessionFromLoginToken(asSession, now)).toBeNull();
    const asLogin = signToken("admin_login", { v: 1, e: "boss@boustan.test", exp: now + 1e6 });
    expect(adminFromSession(asLogin, now)).toBeNull();
    const save = signToken("save", {
      v: 1,
      run: "00000000-0000-4000-8000-000000000000",
      exp: now + 1e6,
    });
    expect(adminFromSession(save, now)).toBeNull();
  });

  it("ends a session on expiry, and when the address leaves ADMIN_EMAILS", () => {
    const now = Date.now();
    const live = signToken("admin_session", { v: 1, e: "boss@boustan.test", exp: now + 1000 });
    expect(adminFromSession(live, now)).toBe("boss@boustan.test");
    expect(adminFromSession(live, now + 2000)).toBeNull();
    process.env.ADMIN_EMAILS = "ops@boustan.test";
    resetEnvForTests();
    expect(adminFromSession(live, now)).toBeNull();
    expect(adminFromSession(undefined)).toBeNull();
  });

  it("reads the session from a request's cookie header", () => {
    const token = signToken("admin_session", {
      v: 1,
      e: "ops@boustan.test",
      exp: Date.now() + 60_000,
    });
    const req = (cookie: string) =>
      new Request("https://game.test/api/admin/x", { headers: { cookie } });
    expect(adminFromRequest(req(`a=1; ${SESSION_COOKIE}=${encodeURIComponent(token)}; b=2`))).toBe(
      "ops@boustan.test",
    );
    expect(adminFromRequest(req("a=1"))).toBeNull();
    expect(adminFromRequest(req(`${SESSION_COOKIE}=garbage`))).toBeNull();
    expect(adminFromRequest(new Request("https://game.test/"))).toBeNull();
  });
});
