/**
 * Admin sign-in (ADM-01): a magic link emailed to an address in ADMIN_EMAILS, which sets a
 * signed 12-hour session cookie. The cookie is httpOnly and SameSite=Lax, and every request
 * checks the address is still on the list, so removing someone from ADMIN_EMAILS signs them
 * out at once. Nothing says whether an address is on the list.
 *
 * The game itself sets no cookies (EMB-07); this one belongs to /admin and is never sent from
 * the iframe's own requests.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { escapeHtml } from "../pages";
import { env } from "../env";
import { log } from "../log";
import { rateLimit } from "../rate-limit";
import { defaultSender, type Sender } from "../email/sender";
import {
  adminLoginTokenSchema,
  adminSessionTokenSchema,
  emailKey,
  signToken,
  verifyToken,
} from "../tokens";

export const SESSION_COOKIE = "boustan_admin";
const LOGIN_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function isAdminEmail(email: string): boolean {
  return env().adminEmails.includes(email.trim().toLowerCase());
}

export type LoginOutcome =
  | { ok: true; /** Only with ADMIN_DEV_LINK=1 and a listed address. */ devLink?: string }
  | { ok: false; reason: "rate_limited" };

/**
 * Emails a sign-in link if the address is allowed. The caller shows the same message either
 * way. With ADMIN_DEV_LINK=1 (dev and demos) the link is also returned, for a listed address.
 */
export async function requestLoginLink(
  rawEmail: string,
  ip: string | null,
  send: Sender = defaultSender,
  now = Date.now(),
): Promise<LoginOutcome> {
  const email = rawEmail.trim().toLowerCase().slice(0, 320);
  const byIp = await rateLimit("adminLogin", `ip:${ip ?? "unknown"}`);
  const byEmail = await rateLimit("adminLogin", `email:${emailKey(email)}`);
  if (!byIp.ok || !byEmail.ok) return { ok: false, reason: "rate_limited" };
  if (!isAdminEmail(email)) {
    log.warn("admin_login_unlisted");
    return { ok: true };
  }
  const token = signToken("admin_login", { v: 1, e: email, exp: now + LOGIN_TTL_MS });
  const link = `${env().appUrl}/admin/verify?t=${encodeURIComponent(token)}`;
  const { subject, html, text } = loginEmail(link);
  try {
    await send({
      to: email,
      subject,
      html,
      text,
      headers: {},
      idempotencyKey: `admin-login-${randomUUID()}`,
      tags: [{ name: "kind", value: "admin_login" }],
    });
  } catch (error) {
    await log.error("admin_login_email_failed", error);
  }
  log.info("admin_login_link_sent");
  return { ok: true, devLink: env().ADMIN_DEV_LINK ? link : undefined };
}

function loginEmail(link: string) {
  const href = escapeHtml(link);
  return {
    subject: "Boustan admin: your sign-in link / Votre lien de connexion",
    html: `<p>Sign in to the Boustan game admin (valid 15 minutes):</p>
<p><a href="${href}">${href}</a></p>
<p>Connectez-vous à l'administration du jeu Boustan (valide 15 minutes) : lien ci-dessus.</p>
<p>If you didn't ask for this, ignore this email.</p>`,
    text: `Sign in to the Boustan game admin (valid 15 minutes):\n${link}\n\nConnectez-vous à l'administration du jeu Boustan (valide 15 minutes) : lien ci-dessus.\nIf you didn't ask for this, ignore this email.`,
  };
}

/** Turns a magic-link token into a session token, or null. */
export function sessionFromLoginToken(token: string, now = Date.now()): string | null {
  const payload = verifyToken("admin_login", token, adminLoginTokenSchema);
  if (!payload || payload.exp < now || !isAdminEmail(payload.e)) return null;
  return signToken("admin_session", { v: 1, e: payload.e, exp: now + SESSION_TTL_MS });
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

/** The signed-in admin's email from a session token, or null. */
export function adminFromSession(token: string | undefined, now = Date.now()): string | null {
  if (!token) return null;
  const payload = verifyToken("admin_session", token, adminSessionTokenSchema);
  if (!payload || payload.exp < now || !isAdminEmail(payload.e)) return null;
  return payload.e;
}

/** For route handlers: the admin behind this request's cookie, or null. */
export function adminFromRequest(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  const match = header.split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return adminFromSession(
    match ? decodeURIComponent(match.slice(SESSION_COOKIE.length + 1)) : undefined,
  );
}

/** For pages and server actions: the admin's email, or a redirect to the login page. */
export async function requireAdmin(): Promise<string> {
  const jar = await cookies();
  const email = adminFromSession(jar.get(SESSION_COOKIE)?.value);
  if (!email) redirect("/admin/login");
  return email;
}
