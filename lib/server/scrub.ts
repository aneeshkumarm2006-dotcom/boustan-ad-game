const EMAIL_LIKE = /[^\s@"'<>()]+@[^\s@"'<>()]+/g;

/**
 * Error text can quote input (a driver error, a provider response). Masks anything email-like
 * and caps the length before it goes to logs or Sentry (NFR-08).
 */
export function scrub(text: string): string {
  return text.replace(EMAIL_LIKE, "[email]").slice(0, 300);
}
