import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  claimTokenSchema,
  emailKey,
  hashToken,
  newPlayerToken,
  runTokenSchema,
  signToken,
  verifyToken,
} from "./tokens";

const run = {
  v: 1 as const,
  id: randomUUID(),
  seed: 123,
  iat: 1_700_000_000_000,
  tv: 1,
  lang: "fr" as const,
  src: "partner",
  host: "https://news.example",
  utm: { utm_campaign: "game-2026" },
  rules: { distanceM: 100, garlic: 10 },
};

describe("signed tokens (SEC-01, SEC-04)", () => {
  it("round-trips a run token", () => {
    expect(verifyToken("run", signToken("run", run), runTokenSchema)).toEqual(run);
  });

  it("rejects a token whose payload was edited", () => {
    const [body, sig] = signToken("run", run).split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), seed: 999 }),
    ).toString("base64url");
    expect(verifyToken("run", `${forged}.${sig}`, runTokenSchema)).toBeNull();
  });

  it("rejects a token signed with another secret", () => {
    const other = signToken("run", run, "another-secret-another-secret-another-secret");
    expect(verifyToken("run", other, runTokenSchema)).toBeNull();
  });

  it("never accepts one kind of token as another", () => {
    const claim = signToken("claim", { v: 1, run: run.id, exp: Date.now() });
    expect(verifyToken("claim", claim, claimTokenSchema)).not.toBeNull();
    expect(verifyToken("run", claim, claimTokenSchema)).toBeNull();
    expect(verifyToken("unsubscribe", claim, claimTokenSchema)).toBeNull();
  });

  it("rejects malformed input", () => {
    for (const bad of ["", "abc", "a.b.c", ".", "x".repeat(3000), "%%%.###"]) {
      expect(verifyToken("run", bad, runTokenSchema)).toBeNull();
    }
  });

  it("rejects a signed payload that breaks the schema", () => {
    const token = signToken("run", { ...run, seed: -5 });
    expect(verifyToken("run", token, runTokenSchema)).toBeNull();
  });
});

describe("player tokens (DATA-01)", () => {
  it("are random, URL-safe, and stored only as a hash", () => {
    const a = newPlayerToken();
    expect(a).toMatch(/^[\w-]{43}$/);
    expect(newPlayerToken()).not.toBe(a);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).not.toContain(a);
  });

  it("rate-limit keys don't contain the email", () => {
    const key = emailKey("alex@gmail.com");
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(emailKey("alex@gmail.com")).toBe(key);
    expect(emailKey("sam@gmail.com")).not.toBe(key);
  });
});
