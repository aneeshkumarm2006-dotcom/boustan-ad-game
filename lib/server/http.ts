/**
 * Shared pieces for the route handlers: JSON responses that are never cached, body parsing
 * with zod and a size cap (SEC-09), request context, error wrapping and cron auth.
 */
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { deviceOf, type Device } from "./analytics";
import { env } from "./env";
import { log } from "./log";

const NO_STORE = { "cache-control": "no-store" };

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(data, { status, headers: { ...NO_STORE, ...headers } });
}

export function apiError(status: number, error: string, headers: Record<string, string> = {}) {
  return json({ error }, status, headers);
}

export function tooMany(retryAfterS: number) {
  return apiError(429, "rate_limited", { "retry-after": String(retryAfterS) });
}

export type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

/** Reads a JSON body of at most `maxBytes` and checks it against the schema. */
export async function readBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBytes = 8 * 1024,
): Promise<Parsed<T>> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return { ok: false, response: apiError(413, "too_large") };
  const text = await request.text();
  if (text.length > maxBytes) return { ok: false, response: apiError(413, "too_large") };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, response: apiError(400, "bad_request") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, response: apiError(400, "bad_request") };
  return { ok: true, data: parsed.data };
}

// ---------- shared field schemas ----------

/** Placement IDs and UTM values: short, printable, no markup (same rule as lib/session). */
const SAFE_VALUE = /^[\p{L}\p{N} ._~:/@+-]{1,100}$/u;
export const safeValue = z.string().trim().regex(SAFE_VALUE);
export const langSchema = z.enum(["fr", "en"]);
export const srcSchema = safeValue.nullable().catch(null);
export const utmSchema = z
  .object({
    utm_source: safeValue.optional().catch(undefined),
    utm_medium: safeValue.optional().catch(undefined),
    utm_campaign: safeValue.optional().catch(undefined),
    utm_content: safeValue.optional().catch(undefined),
  })
  .catch({});
/** The embedding page's origin, as the client reads it from ancestorOrigins. */
export const hostSchema = z
  .string()
  .max(200)
  .nullable()
  .transform((v) => {
    if (!v) return null;
    try {
      const u = new URL(v);
      return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
    } catch {
      return null;
    }
  })
  .catch(null);

// ---------- request context ----------

export function clientIp(headers: Headers): string | null {
  const first = (v: string | null) => v?.split(",")[0]?.trim() || null;
  return (
    first(headers.get("x-vercel-forwarded-for")) ??
    first(headers.get("x-real-ip")) ??
    first(headers.get("x-forwarded-for"))
  );
}

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
  device: Device | null;
  playerToken: string | null;
  clientVersion: string | null;
}

export function requestContext(request: Request): RequestContext {
  const h = request.headers;
  const userAgent = h.get("user-agent");
  const version = h.get("x-client-version");
  const token = h.get("x-player-token");
  return {
    ip: clientIp(h),
    userAgent,
    device: deviceOf(userAgent),
    playerToken: token && token.length <= 200 ? token : null,
    clientVersion: version && /^[\w.-]{1,40}$/.test(version) ? version : null,
  };
}

/** Logs and reports unexpected errors, and answers with a bare 500. */
export function withErrors<A extends unknown[]>(
  name: string,
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (error) {
      await log.error(`${name}_failed`, error);
      return apiError(500, "server");
    }
  };
}

/**
 * Vercel Cron sends "Authorization: Bearer <CRON_SECRET>". Without a secret, cron routes only
 * answer outside production, so they can be called by hand in dev.
 */
export function isCronAuthorized(request: Request): boolean {
  const { CRON_SECRET: secret, production } = env();
  if (!secret) return !production;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
