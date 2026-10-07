import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { deviceOf } from "./analytics";
import { resetEnvForTests } from "./env";
import {
  apiError,
  clientIp,
  hostSchema,
  isCronAuthorized,
  json,
  readBody,
  requestContext,
  srcSchema,
  tooMany,
  utmSchema,
  withErrors,
} from "./http";

describe("request parsing (SEC-09)", () => {
  const post = (body: string, headers: Record<string, string> = {}) =>
    new Request("https://game.test/api/x", { method: "POST", body, headers });
  const schema = z.object({ n: z.number() });

  it("accepts a body that matches the schema", async () => {
    expect(await readBody(post('{"n":1}'), schema)).toEqual({ ok: true, data: { n: 1 } });
  });

  it("answers 400 for bad JSON or a bad shape, 413 when too large", async () => {
    for (const body of ["{", '{"n":"1"}', "[]"]) {
      const res = await readBody(post(body), schema);
      expect(res.ok || res.response.status).toBe(400);
    }
    const big = await readBody(post(`{"n":1,"pad":"${"x".repeat(9000)}"}`), schema);
    expect(big.ok || big.response.status).toBe(413);
  });

  it("drops attribution values that aren't clean text instead of failing", () => {
    expect(srcSchema.parse("lapresse")).toBe("lapresse");
    expect(srcSchema.parse("<script>")).toBeNull();
    expect(srcSchema.parse(undefined)).toBeNull();
    expect(utmSchema.parse({ utm_source: "fb", utm_medium: "<b>" })).toEqual({ utm_source: "fb" });
    expect(utmSchema.parse("nope")).toEqual({});
    expect(hostSchema.parse("https://news.example/path?x")).toBe("https://news.example");
    expect(hostSchema.parse("javascript:alert(1)")).toBeNull();
  });

  it("reads the client IP from Vercel's headers first", () => {
    const h = new Headers({ "x-forwarded-for": "10.0.0.1, 10.0.0.2", "x-real-ip": "198.51.100.9" });
    expect(clientIp(h)).toBe("198.51.100.9");
    expect(clientIp(new Headers({ "x-forwarded-for": "10.0.0.1, 10.0.0.2" }))).toBe("10.0.0.1");
    expect(clientIp(new Headers())).toBeNull();
  });

  it("classes devices coarsely for the funnel (ADM-02)", () => {
    expect(deviceOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148")).toBe(
      "mobile",
    );
    expect(deviceOf("Mozilla/5.0 (Linux; Android 14; SM-A145F) Mobile Safari/537.36")).toBe(
      "mobile",
    );
    expect(deviceOf("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe("tablet");
    expect(deviceOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126")).toBe("desktop");
    expect(deviceOf(null)).toBeNull();
  });
});

describe("request context (DATA-01, EMB-07)", () => {
  const request = (headers: Record<string, string> = {}) =>
    new Request("https://game.test/api/x", { headers });

  it("reads the device token and the client version from their headers, not from cookies", () => {
    expect(
      requestContext(
        request({
          "x-player-token": "token-abc",
          "x-client-version": "1.2.3-beta",
          "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148",
          "x-real-ip": "198.51.100.9",
        }),
      ),
    ).toEqual({
      ip: "198.51.100.9",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148",
      device: "mobile",
      playerToken: "token-abc",
      clientVersion: "1.2.3-beta",
    });
  });

  it("drops a device token that is too long, and a client version that isn't plain", () => {
    expect(requestContext(request({ "x-player-token": "x".repeat(200) })).playerToken).toHaveLength(
      200,
    );
    expect(requestContext(request({ "x-player-token": "x".repeat(201) })).playerToken).toBeNull();
    for (const version of ["has space", "<script>", "x".repeat(41)]) {
      expect(
        requestContext(request({ "x-client-version": version })).clientVersion,
        version,
      ).toBeNull();
    }
  });

  it("has nothing for a bare request", () => {
    expect(requestContext(request())).toEqual({
      ip: null,
      userAgent: null,
      device: null,
      playerToken: null,
      clientVersion: null,
    });
  });
});

describe("responses", () => {
  it("are JSON and never cached", async () => {
    const res = json({ ok: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("carry a short error code, and a retry time when there are too many requests", async () => {
    const closed = apiError(409, "closed");
    expect([closed.status, await closed.json()]).toEqual([409, { error: "closed" }]);
    const limited = tooMany(42);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("42");
    expect(await limited.json()).toEqual({ error: "rate_limited" });
  });

  it("answer an unexpected error with a bare 500, and log it without the player's details", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await withErrors("test_route", async () => {
        throw new Error("duplicate key for jo@videotron.ca");
      })();
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "server" });
      const line = String(logged.mock.calls[0][0]);
      expect(line).toContain("test_route_failed");
      expect(line).not.toContain("jo@videotron.ca");
    } finally {
      logged.mockRestore();
    }
  });
});

describe("cron routes (NFR-08)", () => {
  const original = { secret: process.env.CRON_SECRET, vercel: process.env.VERCEL_ENV };
  const set = (name: "CRON_SECRET" | "VERCEL_ENV", value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    resetEnvForTests();
  };
  const call = (authorization?: string) =>
    new Request("https://game.test/api/cron/rollup", {
      headers: authorization ? { authorization } : {},
    });

  afterEach(() => {
    set("CRON_SECRET", original.secret);
    set("VERCEL_ENV", original.vercel);
  });

  it("can be called by hand outside production when no secret is set", () => {
    set("CRON_SECRET", undefined);
    set("VERCEL_ENV", undefined);
    expect(isCronAuthorized(call())).toBe(true);
    set("VERCEL_ENV", "preview");
    expect(isCronAuthorized(call())).toBe(true);
  });

  it("answers nobody in production when no secret is set", () => {
    set("CRON_SECRET", undefined);
    set("VERCEL_ENV", "production");
    expect(isCronAuthorized(call())).toBe(false);
    expect(isCronAuthorized(call("Bearer anything"))).toBe(false);
  });

  it("wants exactly `Bearer <secret>` when there is one, in production or not", () => {
    for (const vercel of [undefined, "production"]) {
      set("CRON_SECRET", "a-cron-secret-0123456789");
      set("VERCEL_ENV", vercel);
      expect(isCronAuthorized(call("Bearer a-cron-secret-0123456789"))).toBe(true);
      expect(isCronAuthorized(call())).toBe(false);
      expect(isCronAuthorized(call("a-cron-secret-0123456789"))).toBe(false);
      expect(isCronAuthorized(call("Bearer a-cron-secret-012345678"))).toBe(false);
      expect(isCronAuthorized(call("Bearer a-cron-secret-0123456780"))).toBe(false);
      expect(isCronAuthorized(call("bearer a-cron-secret-0123456789"))).toBe(false);
    }
  });
});
