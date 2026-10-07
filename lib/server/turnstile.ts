/**
 * Cloudflare Turnstile, verified on the server for "Save my score" (SEC-05).
 * With TURNSTILE_SECRET blank the check is skipped, except in production, where that is a
 * configuration error and every save is refused.
 */
import { env } from "./env";
import { log } from "./log";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileResult = "ok" | "failed" | "unavailable";

let warned = false;

export async function verifyTurnstile(
  token: string,
  ip: string | null,
  idempotencyKey: string,
): Promise<TurnstileResult> {
  const { TURNSTILE_SECRET: secret, production } = env();
  if (!secret) {
    if (production) {
      void log.error("turnstile_not_configured", new Error("TURNSTILE_SECRET is blank"));
      return "unavailable";
    }
    if (!warned) {
      warned = true;
      log.warn("turnstile_skipped");
    }
    return "ok";
  }
  if (!token || token.length > 2048) return "failed";
  const body = new URLSearchParams({ secret, response: token, idempotency_key: idempotencyKey });
  if (ip) body.set("remoteip", ip);
  try {
    const res = await fetch(VERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return "unavailable";
    const data = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    if (!data.success) {
      log.info("turnstile_failed", { codes: (data["error-codes"] ?? []).join(",") });
      return "failed";
    }
    return "ok";
  } catch (error) {
    void log.error("turnstile_unreachable", error);
    return "unavailable";
  }
}
