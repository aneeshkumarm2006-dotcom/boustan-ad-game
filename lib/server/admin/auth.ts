/**
 * Admin sign-in (ADM-01): one shared password, ADMIN_PASSWORD, which sets a signed 12-hour
 * session cookie. The cookie is httpOnly and SameSite=Lax. It carries a stamp of the password it
 * was issued for, so changing ADMIN_PASSWORD signs every admin out at once. With no password set,
 * nobody can sign in.
 *
 * The game itself sets no cookies (EMB-07); this one belongs to /admin and is never sent from
 * the iframe's own requests.
 */
import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "../env";
import { log } from "../log";
import { rateLimit } from "../rate-limit";
import { adminPasswordStamp, adminSessionTokenSchema, signToken, verifyToken } from "../tokens";

export const SESSION_COOKIE = "boustan_admin";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_PASSWORD_LENGTH = 200;

/** Everyone shares one login, so this is the name the audit log records. */
export const ADMIN_NAME = "admin";

export type LoginOutcome =
  | { ok: true; session: string }
  | { ok: false; reason: "wrong" | "rate_limited" | "not_configured" };

/** Constant-time comparison: both sides are hashed first, so length doesn't leak. */
function samePassword(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Checks the password and, if it is right, returns a session token for the cookie. */
export async function signInWithPassword(
  rawPassword: string,
  ip: string | null,
  now = Date.now(),
): Promise<LoginOutcome> {
  const expected = env().ADMIN_PASSWORD;
  if (!expected) {
    log.warn("admin_login_not_configured");
    return { ok: false, reason: "not_configured" };
  }
  const limit = await rateLimit("adminLogin", `ip:${ip ?? "unknown"}`);
  if (!limit.ok) return { ok: false, reason: "rate_limited" };
  const password = rawPassword.trim();
  if (password.length > MAX_PASSWORD_LENGTH || !samePassword(password, expected)) {
    log.warn("admin_login_failed");
    return { ok: false, reason: "wrong" };
  }
  log.info("admin_login");
  const session = signToken("admin_session", {
    v: 1,
    p: adminPasswordStamp(expected),
    exp: now + SESSION_TTL_MS,
  });
  return { ok: true, session };
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env().appUrl.startsWith("https://"),
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  };
}

/** The admin's name from a session token, or null if it is missing, forged, expired or stale. */
export function adminFromSession(token: string | undefined, now = Date.now()): string | null {
  if (!token) return null;
  const expected = env().ADMIN_PASSWORD;
  if (!expected) return null;
  const payload = verifyToken("admin_session", token, adminSessionTokenSchema);
  if (!payload || payload.exp < now || payload.p !== adminPasswordStamp(expected)) return null;
  return ADMIN_NAME;
}

/** For route handlers: the admin behind this request's cookie, or null. */
export function adminFromRequest(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  const match = header.split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return adminFromSession(
    match ? decodeURIComponent(match.slice(SESSION_COOKIE.length + 1)) : undefined,
  );
}

/** For pages and server actions: the admin's name, or a redirect to the login page. */
export async function requireAdmin(): Promise<string> {
  const jar = await cookies();
  const admin = adminFromSession(jar.get(SESSION_COOKIE)?.value);
  if (!admin) redirect("/admin/login");
  return admin;
}
