/**
 * Minimal Sentry client for server errors and alerts (NFR-08): one envelope POST per event,
 * no SDK. The Next.js SDK would add OpenTelemetry instrumentation to every cold start and a
 * build plugin; the game only needs errors with tags. Messages are scrubbed of anything
 * email-like before they leave. Does nothing when SENTRY_DSN is blank.
 */
import { randomUUID } from "node:crypto";
import { scrub } from "./scrub";

type Tags = Record<string, string | number | boolean | null | undefined>;

interface Dsn {
  url: string;
  key: string;
  raw: string;
}

let parsed: Dsn | null | undefined;

function dsn(): Dsn | null {
  if (parsed !== undefined) return parsed;
  const raw = process.env.SENTRY_DSN?.trim();
  parsed = null;
  if (!raw) return parsed;
  try {
    const u = new URL(raw);
    const project = u.pathname.replace(/^\//, "");
    parsed = { url: `${u.protocol}//${u.host}/api/${project}/envelope/`, key: u.username, raw };
  } catch {
    console.warn(JSON.stringify({ level: "warn", event: "sentry_dsn_invalid" }));
  }
  return parsed;
}

function frames(stack: string | undefined) {
  if (!stack) return undefined;
  const lines = stack.split("\n").slice(1, 30);
  const out = lines
    .map((line) => /at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({
      function: m[1] ?? "?",
      filename: m[2],
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: !m[2].includes("node_modules"),
    }))
    .reverse(); // Sentry wants the crashing frame last.
  return out.length > 0 ? { frames: out } : undefined;
}

async function send(event: Record<string, unknown>): Promise<void> {
  const d = dsn();
  if (!d) return;
  const id = randomUUID().replace(/-/g, "");
  const body = [
    JSON.stringify({ event_id: id, sent_at: new Date().toISOString(), dsn: d.raw }),
    JSON.stringify({ type: "event" }),
    JSON.stringify({
      event_id: id,
      timestamp: Date.now() / 1000,
      platform: "node",
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
      release: process.env.VERCEL_GIT_COMMIT_SHA,
      server_name: "boustan-game",
      ...event,
    }),
  ].join("\n");
  try {
    await fetch(d.url, {
      method: "POST",
      headers: {
        "content-type": "application/x-sentry-envelope",
        "x-sentry-auth": `Sentry sentry_version=7, sentry_client=boustan-game/1, sentry_key=${d.key}`,
      },
      body,
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Never let error reporting break a request.
  }
}

function cleanTags(tags: Tags): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) if (v !== undefined && v !== null) out[k] = String(v);
  return out;
}

export function captureException(error: unknown, tags: Tags = {}): Promise<void> {
  const err = error instanceof Error ? error : new Error(String(error));
  return send({
    level: "error",
    exception: {
      values: [{ type: err.name, value: scrub(err.message), stacktrace: frames(err.stack) }],
    },
    tags: cleanTags(tags),
  });
}

/**
 * A message event. `fingerprint` groups repeats into one Sentry issue, which an issue alert
 * rule turns into an email or Slack ping (claim error rate, bounce spikes).
 */
export function captureMessage(
  message: string,
  {
    level = "error",
    tags = {},
    fingerprint,
  }: { level?: string; tags?: Tags; fingerprint?: string[] },
): Promise<void> {
  return send({
    level,
    message: { formatted: scrub(message) },
    tags: cleanTags(tags),
    ...(fingerprint ? { fingerprint } : {}),
  });
}
