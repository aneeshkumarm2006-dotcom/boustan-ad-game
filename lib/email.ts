/**
 * Client-side email helpers. The server re-checks everything and owns normalization (RWD-05).
 */

/**
 * Same shape check the server uses first: one @, a dot in the domain, no spaces, plain ASCII
 * (accented addresses like marie-ève@… are refused by the server and most mailboxes).
 */
export function looksLikeEmail(value: string): boolean {
  const v = value.trim();
  return v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && /^[!-~]+$/.test(v);
}

/**
 * One player per person (SEC-07): trim, lowercase, drop a "+tag" from the local part,
 * and for gmail.com / googlemail.com drop dots too. The address as typed is kept for sending.
 */
export function normalizeEmail(email: string): string {
  const v = email.trim().toLowerCase();
  const at = v.lastIndexOf("@");
  if (at < 1) return v;
  let local = v.slice(0, at);
  let domain = v.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus);
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replace(/\./g, "");
    domain = "gmail.com";
  }
  return `${local}@${domain}`;
}

/** Longest full name the save form accepts (LB-05). */
export const NAME_MAX = 40;

/** Leaderboard name rules (LB-05): the player's full name, 2–40 letters (accents allowed), digits, spaces, -_.' */
export function isValidNickname(value: string): boolean {
  const v = value.trim();
  return /^[\p{L}\p{N} _.'’-]{2,40}$/u.test(v);
}
