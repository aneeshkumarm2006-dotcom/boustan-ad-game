import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  adminLoginTokenSchema,
  adminSessionTokenSchema,
  emailKey,
  hashToken,
  newPlayerToken,
  runTokenSchema,
  saveTokenSchema,
  signToken,
  verifyToken,
  type TokenKind,
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
};

describe("signed tokens (SEC-01, SEC-04)", () => {
  it("round-trips a run token", () => {
    expect(verifyToken("run", signToken("run", run), runTokenSchema)).toEqual(run);
  });

  it("round-trips a save token", () => {
    const save = { v: 1 as const, run: run.id, exp: Date.now() + 60_000 };
    expect(verifyToken("save", signToken("save", save), saveTokenSchema)).toEqual(save);
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

  it("rejects malformed input", () => {
    for (const bad of ["", "abc", "a.b.c", ".", "x".repeat(3000), "%%%.###"]) {
      expect(verifyToken("run", bad, runTokenSchema)).toBeNull();
    }
  });

  it("rejects a signed payload that breaks the schema", () => {
    expect(verifyToken("run", signToken("run", { ...run, seed: -5 }), runTokenSchema)).toBeNull();
    expect(
      verifyToken("run", signToken("run", { ...run, seed: 2 ** 32 }), runTokenSchema),
    ).toBeNull();
    expect(
      verifyToken("run", signToken("run", { ...run, id: "not-a-uuid" }), runTokenSchema),
    ).toBeNull();
    expect(verifyToken("run", signToken("run", { ...run, lang: "de" }), runTokenSchema)).toBeNull();
    expect(
      verifyToken("run", signToken("run", { ...run, utm: { utm_other: "x" } }), runTokenSchema),
    ).toBeNull();
  });

  it("has no scoring rules in a run token: a run is scored by the server", () => {
    expect(Object.keys(runTokenSchema.shape).sort()).toEqual([
      "host",
      "iat",
      "id",
      "lang",
      "seed",
      "src",
      "tv",
      "utm",
      "v",
    ]);
  });

  it("still accepts a run token issued before the points contest, and drops its rules", () => {
    const old = signToken("run", { ...run, rules: { distanceM: 100, garlic: 10 } });
    expect(verifyToken("run", old, runTokenSchema)).toEqual(run);
  });

  it("leaves expiry to the caller, which knows the clock", () => {
    const expired = { v: 1 as const, run: run.id, exp: 1 };
    expect(verifyToken("save", signToken("save", expired), saveTokenSchema)).toEqual(expired);
  });
});

describe("one kind of token never passes as another (SEC-04, ADM-01)", () => {
  const payloads: Record<Exclude<TokenKind, "email_key">, object> = {
    run,
    save: { v: 1, run: run.id, exp: Date.now() + 60_000 },
    admin_login: { v: 1, e: "admin@boustan.test", exp: Date.now() + 60_000 },
    admin_session: { v: 1, e: "admin@boustan.test", exp: Date.now() + 60_000 },
  };
  const schemas: Record<keyof typeof payloads, z.ZodType> = {
    run: runTokenSchema,
    save: saveTokenSchema,
    admin_login: adminLoginTokenSchema,
    admin_session: adminSessionTokenSchema,
  };
  const kinds = Object.keys(payloads) as (keyof typeof payloads)[];

  it("accepts each kind only under its own name, whichever schema is asked", () => {
    for (const signed of kinds) {
      const token = signToken(signed, payloads[signed]);
      for (const asked of kinds) {
        for (const schema of Object.values(schemas)) {
          const result = verifyToken(asked, token, schema);
          // Whatever the schema says, a token signed for another kind has the wrong signature.
          if (asked !== signed) expect(result, `${signed} as ${asked}`).toBeNull();
        }
        if (asked === signed) {
          expect(verifyToken(asked, token, schemas[asked]), asked).not.toBeNull();
        }
      }
    }
  });

  it("keeps a sign-in link from working as a session cookie, though their payloads match", () => {
    const login = signToken("admin_login", payloads.admin_login);
    expect(verifyToken("admin_session", login, adminSessionTokenSchema)).toBeNull();
    const session = signToken("admin_session", payloads.admin_session);
    expect(verifyToken("admin_login", session, adminLoginTokenSchema)).toBeNull();
  });

  it("keeps a run token from being spent as a save token", () => {
    const token = signToken("run", run);
    expect(verifyToken("save", token, saveTokenSchema)).toBeNull();
    expect(verifyToken("save", token, runTokenSchema)).toBeNull();
  });
});

describe("player tokens (DATA-01)", () => {
  it("are random, URL-safe, and stored only as a hash", () => {
    const a = newPlayerToken();
    expect(a).toMatch(/^[\w-]{43}$/);
    expect(newPlayerToken()).not.toBe(a);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).not.toContain(a);
    expect(hashToken(a)).toBe(hashToken(a));
  });

  it("rate-limit keys don't contain the email", () => {
    const key = emailKey("alex@gmail.com");
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(emailKey("alex@gmail.com")).toBe(key);
    expect(emailKey("sam@gmail.com")).not.toBe(key);
    expect(key).not.toContain("alex");
  });
});
