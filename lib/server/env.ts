/**
 * Server configuration, read and checked once on first use. Secrets never leave the server:
 * `server-only` makes the build fail if a client component imports this file (SEC-09).
 * Error messages name the missing variables, never their values.
 */
import "server-only";
import { z } from "zod";

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const schema = z.object({
  MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//),
  MONGODB_POOL_MAX: z.coerce.number().int().min(1).max(50).optional(),
  RUN_TOKEN_SECRET: z.string().min(32, "RUN_TOKEN_SECRET must be at least 32 characters"),
  TURNSTILE_SECRET: optional,
  UPSTASH_REDIS_REST_URL: optional,
  UPSTASH_REDIS_REST_TOKEN: optional,
  RATE_LIMITS: optional,
  CRON_SECRET: optional,
  HUBSPOT_SIGNUP_WEBHOOK_URL: optional.pipe(z.url().startsWith("https://").optional()),
  /** The one password for /admin (ADM-01). Blank: nobody can sign in. */
  ADMIN_PASSWORD: optional,
  SENTRY_DSN: optional,
  APP_URL: optional,
  VERCEL_ENV: optional,
  VERCEL_BRANCH_URL: optional,
  VERCEL_URL: optional,
  VERCEL_GIT_COMMIT_SHA: optional,
  NODE_ENV: z.string().default("development"),
});

export type Env = z.infer<typeof schema> & {
  /**
   * The Vercel production deployment. Dev, previews and local production builds are not: they
   * may skip Turnstile and cron auth when those secrets are blank.
   */
  production: boolean;
  /** Absolute base URL of this deployment (secure-cookie check, share links, social preview). */
  appUrl: string;
};

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Server configuration is invalid: ${names}`);
  }
  const e = parsed.data;
  const production = e.VERCEL_ENV === "production";
  const host = e.VERCEL_BRANCH_URL ?? e.VERCEL_URL;
  const appUrl = (e.APP_URL ?? (host ? `https://${host}` : "http://localhost:3000")).replace(
    /\/$/,
    "",
  );
  cached = { ...e, production, appUrl };
  return cached;
}

/** Tests change process.env between cases. */
export function resetEnvForTests(): void {
  cached = null;
}
