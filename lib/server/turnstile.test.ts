import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvForTests } from "./env";
import { verifyTurnstile } from "./turnstile";

const SECRET = "1x0000000000000000000000000000000AA";
const original = { secret: process.env.TURNSTILE_SECRET, vercel: process.env.VERCEL_ENV };

function setEnv(name: "TURNSTILE_SECRET" | "VERCEL_ENV", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  resetEnvForTests();
}

describe("Turnstile bot check on 'Save my score' (SEC-05)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv("VERCEL_ENV", undefined);
    setEnv("TURNSTILE_SECRET", SECRET);
  });
  afterEach(() => {
    setEnv("TURNSTILE_SECRET", original.secret);
    setEnv("VERCEL_ENV", original.vercel);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("is skipped outside production when no secret is set", async () => {
    setEnv("TURNSTILE_SECRET", "");
    expect(await verifyTurnstile("", null, "key")).toBe("ok");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses every save in production when no secret is set, which is a configuration error", async () => {
    setEnv("TURNSTILE_SECRET", "");
    setEnv("VERCEL_ENV", "production");
    expect(await verifyTurnstile("token", null, "key")).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails a missing or oversized token without asking Cloudflare", async () => {
    expect(await verifyTurnstile("", "203.0.113.7", "key")).toBe("failed");
    expect(await verifyTurnstile("x".repeat(2049), "203.0.113.7", "key")).toBe("failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks Cloudflare with the secret, the token, the key and the address, and passes on success", async () => {
    fetchMock.mockResolvedValue(Response.json({ success: true }));
    expect(await verifyTurnstile("the-token", "203.0.113.7", "idem-1")).toBe("ok");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(init.method).toBe("POST");
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      secret: SECRET,
      response: "the-token",
      idempotency_key: "idem-1",
      remoteip: "203.0.113.7",
    });
  });

  it("leaves out the address when there is none", async () => {
    fetchMock.mockResolvedValue(Response.json({ success: true }));
    await verifyTurnstile("the-token", null, "idem-2");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(Object.fromEntries(init.body as URLSearchParams)).not.toHaveProperty("remoteip");
  });

  it("fails when Cloudflare says the token is no good", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ success: false, "error-codes": ["timeout-or-duplicate"] }),
    );
    expect(await verifyTurnstile("the-token", null, "key")).toBe("failed");
  });

  it("is unavailable, not failed, when Cloudflare errors or can't be reached", async () => {
    fetchMock.mockResolvedValueOnce(new Response("busy", { status: 503 }));
    expect(await verifyTurnstile("the-token", null, "key")).toBe("unavailable");
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    expect(await verifyTurnstile("the-token", null, "key")).toBe("unavailable");
  });
});
