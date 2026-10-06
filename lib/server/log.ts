/**
 * Structured logs, one JSON object per line (NFR-08). No personal data: callers pass ids,
 * reasons and counts, never emails, IPs, codes or tokens, and fields with those names are
 * dropped as a backstop. Errors also go to Sentry when SENTRY_DSN is set.
 */
import { scrub } from "./scrub";
import { captureException } from "./sentry";

type Value = string | number | boolean | null | undefined;
export type LogFields = Record<string, Value>;

const PERSONAL = /email|^ip$|token|^code$|agent|address|nickname/i;

function clean(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && !PERSONAL.test(key)) out[key] = value;
  }
  return out;
}

function write(level: "info" | "warn" | "error", event: string, fields: LogFields): void {
  const line = JSON.stringify({ level, event, ...clean(fields), ts: new Date().toISOString() });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields: LogFields = {}) => write("info", event, fields),
  warn: (event: string, fields: LogFields = {}) => write("warn", event, fields),
  error(event: string, error: unknown, fields: LogFields = {}): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    write("error", event, { ...fields, error: scrub(message) });
    return captureException(error, { event, ...clean(fields) });
  },
};
