/**
 * Signed, self-contained tokens (SEC-01, SEC-04, DATA-07): `base64url(json).base64url(hmac)`.
 * Each kind signs with its own key derived from RUN_TOKEN_SECRET, so a token of one kind can
 * never pass as another. Expiry and single use are checked by the caller, which knows the
 * clock and the database.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "./env";

export type TokenKind = "run" | "save" | "email_key" | "admin_session";

const keys = new Map<string, Buffer>();
function keyFor(kind: TokenKind, secret: string): Buffer {
  const id = `${kind}:${secret}`;
  let key = keys.get(id);
  if (!key) {
    key = createHmac("sha256", secret).update(`boustan-game:${kind}`).digest();
    keys.set(id, key);
  }
  return key;
}

function mac(kind: TokenKind, body: string, secret: string): Buffer {
  return createHmac("sha256", keyFor(kind, secret)).update(body).digest();
}

export function signToken(kind: TokenKind, payload: object, secret = env().RUN_TOKEN_SECRET) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(kind, body, secret).toString("base64url")}`;
}

/** The payload if the signature is right and it matches the schema; otherwise null. */
export function verifyToken<T>(
  kind: TokenKind,
  token: string,
  schema: z.ZodType<T>,
  secret = env().RUN_TOKEN_SECRET,
): T | null {
  if (token.length > 2048) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const body = token.slice(0, dot);
  let given: Buffer;
  try {
    given = Buffer.from(token.slice(dot + 1), "base64url");
  } catch {
    return null;
  }
  const expected = mac(kind, body, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------- the token kinds ----------

const utm = z
  .object({
    utm_source: z.string().max(100).optional(),
    utm_medium: z.string().max(100).optional(),
    utm_campaign: z.string().max(100).optional(),
    utm_content: z.string().max(100).optional(),
  })
  .strict();

/** Issued by POST /api/runs/start, spent by finish (SEC-01). */
export const runTokenSchema = z.object({
  v: z.literal(1),
  id: z.uuid(),
  seed: z.number().int().min(0).max(0xffffffff),
  /** Issue time, ms since epoch. */
  iat: z.number().int(),
  /** TUNING.version the level was built under. */
  tv: z.number().int(),
  lang: z.enum(["fr", "en"]),
  src: z.string().max(100).nullable(),
  host: z.string().max(200).nullable(),
  utm,
});
export type RunToken = z.infer<typeof runTokenSchema>;

/** Issued by finish for a validated run; single use, 30 minutes (SEC-04). Saves the score. */
export const saveTokenSchema = z.object({
  v: z.literal(1),
  run: z.uuid(),
  exp: z.number().int(),
});
export type SaveToken = z.infer<typeof saveTokenSchema>;

/**
 * The admin session cookie (ADM-01): 12 hours. `p` stamps the ADMIN_PASSWORD it was issued for
 * (an HMAC, never the password), so changing the password signs every admin out.
 */
export const adminSessionTokenSchema = z.object({
  v: z.literal(1),
  p: z.string().max(64),
  exp: z.number().int(),
});

/** Stamp of the current admin password, for the session cookie. Not reversible without the secret. */
export function adminPasswordStamp(password: string, secret = env().RUN_TOKEN_SECRET): string {
  return createHmac("sha256", secret).update(`admin-password:${password}`).digest("base64url");
}

// ---------- opaque tokens and hashes ----------

/** Player token for the device (DATA-01). Only its hash is stored. */
export function newPlayerToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Stable key for rate limits on an email, without putting the address in Redis. */
export function emailKey(normalizedEmail: string, secret = env().RUN_TOKEN_SECRET): string {
  return createHmac("sha256", keyFor("email_key", secret))
    .update(`rl:${normalizedEmail}`)
    .digest("hex")
    .slice(0, 32);
}
