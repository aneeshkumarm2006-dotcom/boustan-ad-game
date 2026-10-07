/**
 * Server-side email checks for saving a score (SEC-07, DATA-04): shape, disposable domains, and
 * the normalized form that keeps one player per person.
 */
import { z } from "zod";
import { looksLikeEmail, normalizeEmail } from "@/lib/email";
import blocklist from "./data/disposable-domains.json";

let disposable: Set<string> | null = null;

/** True when the domain, or any parent domain, is on the disposable-email blocklist. */
export function isDisposableDomain(domain: string): boolean {
  disposable ??= new Set(blocklist.domains);
  const parts = domain.toLowerCase().replace(/\.$/, "").split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    if (disposable.has(parts.slice(i).join("."))) return true;
  }
  return false;
}

const shape = z.email();

export type EmailCheck =
  { ok: true; email: string; normalized: string } | { ok: false; reason: "invalid" | "disposable" };

/** The address as typed (trimmed) for sending, and its normalized form for uniqueness. */
export function checkEmail(raw: string): EmailCheck {
  const email = raw.trim();
  const at = email.lastIndexOf("@");
  if (!looksLikeEmail(email) || at > 64 || !shape.safeParse(email).success) {
    return { ok: false, reason: "invalid" };
  }
  if (isDisposableDomain(email.slice(at + 1))) return { ok: false, reason: "disposable" };
  return { ok: true, email, normalized: normalizeEmail(email) };
}
