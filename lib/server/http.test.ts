import { describe, expect, it } from "vitest";
import { z } from "zod";
import { deviceOf } from "./analytics";
import { clientIp, hostSchema, readBody, srcSchema, utmSchema } from "./http";

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
