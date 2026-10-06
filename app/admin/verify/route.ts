import { audit } from "@/lib/server/admin/audit";
import {
  SESSION_COOKIE,
  adminFromSession,
  sessionCookieOptions,
  sessionFromLoginToken,
} from "@/lib/server/admin/auth";
import { db } from "@/lib/server/db";
import { withErrors } from "@/lib/server/http";

const go = (location: string, extra: Record<string, string> = {}) =>
  new Response(null, {
    status: 303,
    headers: { location, "cache-control": "no-store", ...extra },
  });

/** The magic link lands here: trade the signed token for a session cookie (ADM-01). */
export const GET = withErrors("admin_verify", async (request: Request) => {
  const token = new URL(request.url).searchParams.get("t") ?? "";
  const session = sessionFromLoginToken(token);
  const admin = session ? adminFromSession(session) : null;
  if (!session || !admin) return go("/admin/login?error=link");

  await audit(db(), admin, "admin.login");
  const o = sessionCookieOptions();
  const cookie = [
    `${SESSION_COOKIE}=${encodeURIComponent(session)}`,
    `Path=${o.path}`,
    `Max-Age=${o.maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(o.secure ? ["Secure"] : []),
  ].join("; ");
  return go("/admin", { "set-cookie": cookie });
});
