/**
 * Rate limits (SEC-06) on Upstash Redis, sliding windows. Defaults follow the PRD and can be
 * overridden without a code change: RATE_LIMITS="saveIp=10/3600,runStart=120/3600".
 *
 * Without Upstash credentials (dev, tests) an in-memory limiter per server instance stands in.
 * If Redis is slow or down, requests are allowed: a limiter outage must not take the game
 * down, and the save path has its own database-level guarantees (SEC-04, SEC-07).
 */
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { env } from "./env";
import { log } from "./log";

export interface Rule {
  limit: number;
  windowS: number;
}

export const DEFAULT_LIMITS = {
  /** Run starts per IP. */
  runStart: { limit: 60, windowS: 3600 },
  /** "Save my score" per IP. */
  saveIp: { limit: 5, windowS: 3600 },
  /** Leaderboard reads per IP. */
  leaderboard: { limit: 120, windowS: 60 },
  /** Admin sign-in links per IP and per address. */
  adminLogin: { limit: 10, windowS: 3600 },
  /** Analytics batches per IP. */
  events: { limit: 600, windowS: 3600 },
} satisfies Record<string, Rule>;

export type LimitName = keyof typeof DEFAULT_LIMITS;

export function parseLimits(value: string | undefined): Record<LimitName, Rule> {
  const rules: Record<LimitName, Rule> = { ...DEFAULT_LIMITS };
  for (const part of (value ?? "").split(",")) {
    const m = /^\s*(\w+)\s*=\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(part);
    if (m && m[1] in rules) rules[m[1] as LimitName] = { limit: +m[2], windowS: +m[3] };
  }
  return rules;
}

export interface LimitResult {
  ok: boolean;
  /** Seconds until the window frees up a slot. */
  retryAfterS: number;
}

// ---------- in-memory fallback ----------

const hits = new Map<string, number[]>();

function memoryLimit(key: string, rule: Rule, now = Date.now()): LimitResult {
  const since = now - rule.windowS * 1000;
  const list = (hits.get(key) ?? []).filter((t) => t > since);
  if (list.length >= rule.limit) {
    hits.set(key, list);
    return { ok: false, retryAfterS: Math.ceil((list[0] + rule.windowS * 1000 - now) / 1000) };
  }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 50_000) hits.delete(hits.keys().next().value as string);
  return { ok: true, retryAfterS: 0 };
}

export function resetMemoryLimitsForTests(): void {
  hits.clear();
}

// ---------- Upstash ----------

let limiters: Map<LimitName, Ratelimit> | null = null;
let warned = false;

function upstash(): Map<LimitName, Ratelimit> | null {
  const e = env();
  if (!e.UPSTASH_REDIS_REST_URL || !e.UPSTASH_REDIS_REST_TOKEN) {
    if (e.production && !warned) {
      warned = true;
      log.warn("rate_limit_memory_fallback");
    }
    return null;
  }
  if (!limiters) {
    const redis = new Redis({ url: e.UPSTASH_REDIS_REST_URL, token: e.UPSTASH_REDIS_REST_TOKEN });
    const rules = parseLimits(e.RATE_LIMITS);
    limiters = new Map(
      (Object.keys(rules) as LimitName[]).map((name) => [
        name,
        new Ratelimit({
          redis,
          prefix: `rl:${name}`,
          limiter: Ratelimit.slidingWindow(rules[name].limit, `${rules[name].windowS} s`),
          timeout: 1000,
          analytics: false,
        }),
      ]),
    );
  }
  return limiters;
}

/** Counts one hit for `key` against the named limit. */
export async function rateLimit(name: LimitName, key: string): Promise<LimitResult> {
  const remote = upstash()?.get(name);
  if (!remote) return memoryLimit(`${name}:${key}`, parseLimits(env().RATE_LIMITS)[name]);
  try {
    const res = await remote.limit(key);
    return {
      ok: res.success,
      retryAfterS: res.success ? 0 : Math.max(1, Math.ceil((res.reset - Date.now()) / 1000)),
    };
  } catch (error) {
    void log.error("rate_limit_unavailable", error, { limit: name });
    return { ok: true, retryAfterS: 0 };
  }
}
