/**
 * Campaign settings and reward availability, read from the database so they change without a
 * redeploy (SEC-08, ADM-07). Run starts read a copy cached for a few seconds per instance (500
 * starts/s, NFR-04); claims always read fresh, so a kill switch stops claims at once.
 */
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { campaignSettings, codes, rewards, type RunRules } from "@/db/schema";
import type { Queryable } from "@/db/client";
import {
  DEFAULT_REWARD_RULES,
  REWARD_IDS,
  isRewardId,
  type RewardId,
  type RewardRules,
} from "@/game-core";
import type { CampaignState } from "@/lib/api/types";
import { db } from "./db";

export interface RewardConfig {
  active: boolean;
  /** Metres for free_coke, garlic for free_garlic_sauce. */
  threshold: number;
  validityDays: number | null;
  validUntil: Date | null;
  /** Unexpired codes left in the pool. */
  available: number;
}

export interface Campaign {
  startsAt: Date | null;
  endsAt: Date | null;
  claimsEnabled: boolean;
  rewards: Record<RewardId, RewardConfig>;
}

const DEFAULT_THRESHOLD: Record<RewardId, number> = {
  free_coke: DEFAULT_REWARD_RULES.free_coke.distanceM,
  free_garlic_sauce: DEFAULT_REWARD_RULES.free_garlic_sauce.garlic,
};

function thresholdOf(id: RewardId, rule: unknown): number {
  const r = (rule ?? {}) as Record<string, unknown>;
  const value = id === "free_coke" ? r.distanceM : r.garlic;
  return typeof value === "number" && value > 0 ? value : DEFAULT_THRESHOLD[id];
}

export async function loadCampaign(q: Queryable, now = new Date()): Promise<Campaign> {
  const [settings] = await q.select().from(campaignSettings).where(eq(campaignSettings.id, 1));
  const rows = await q.select().from(rewards);
  const stock = await q
    .select({ rewardId: codes.rewardId, n: sql<number>`count(*)::int` })
    .from(codes)
    .where(
      and(eq(codes.status, "available"), or(isNull(codes.expiresAt), gt(codes.expiresAt, now))),
    )
    .groupBy(codes.rewardId);

  const out = {} as Record<RewardId, RewardConfig>;
  for (const id of REWARD_IDS) {
    // A reward missing from the catalogue can't be claimed.
    out[id] = {
      active: false,
      threshold: DEFAULT_THRESHOLD[id],
      validityDays: null,
      validUntil: null,
      available: 0,
    };
  }
  for (const row of rows) {
    if (!isRewardId(row.id)) continue;
    out[row.id] = {
      active: row.active,
      threshold: thresholdOf(row.id, row.rule),
      validityDays: row.validityDays,
      validUntil: row.validUntil,
      available: 0,
    };
  }
  for (const s of stock) if (isRewardId(s.rewardId)) out[s.rewardId].available = s.n;

  return {
    startsAt: settings?.startsAt ?? null,
    endsAt: settings?.endsAt ?? null,
    claimsEnabled: settings?.claimsEnabled ?? false,
    rewards: out,
  };
}

const CACHE_MS = 5000;
let cache: { at: number; value: Promise<Campaign> } | null = null;

/** loadCampaign through a short per-instance cache. A failed load is not cached. */
export function cachedCampaign(): Promise<Campaign> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  const value = loadCampaign(db());
  cache = { at: now, value };
  value.catch(() => {
    if (cache?.value === value) cache = null;
  });
  return value;
}

export function clearCampaignCache(): void {
  cache = null;
}

export function campaignStatus(c: Campaign, now: Date): CampaignState["status"] {
  if (c.startsAt && now < c.startsAt) return "not_started";
  if (c.endsAt && now >= c.endsAt) return "ended";
  return "active";
}

export function claimsOpen(c: Campaign, now: Date): boolean {
  return c.claimsEnabled && campaignStatus(c, now) === "active";
}

/** Whether a reward can be claimed right now: campaign open, reward on, codes left. */
export function rewardClaimable(c: Campaign, id: RewardId, now: Date): boolean {
  const r = c.rewards[id];
  return claimsOpen(c, now) && r.active && r.available > 0;
}

/** Thresholds to carry in a new run token. */
export function runRules(c: Campaign): RunRules {
  return {
    distanceM: c.rewards.free_coke.threshold,
    garlic: c.rewards.free_garlic_sauce.threshold,
  };
}

export function rewardRules(rules: RunRules): RewardRules {
  return { free_coke: { distanceM: rules.distanceM }, free_garlic_sauce: { garlic: rules.garlic } };
}

/** What the start screen needs (§3.4): status, dates, switches, thresholds, availability. */
export function campaignState(c: Campaign, now: Date): CampaignState {
  const availability = (id: RewardId) => {
    const r = c.rewards[id];
    if (!r.active) return { available: false, reason: "paused" } as const;
    if (r.available <= 0) return { available: false, reason: "sold_out" } as const;
    return { available: true } as const;
  };
  return {
    status: campaignStatus(c, now),
    startsAt: c.startsAt?.toISOString() ?? null,
    endsAt: c.endsAt?.toISOString() ?? null,
    claimsEnabled: c.claimsEnabled,
    rules: rewardRules(runRules(c)),
    rewards: {
      free_coke: availability("free_coke"),
      free_garlic_sauce: availability("free_garlic_sauce"),
    },
  };
}

/** Days a code stays valid when neither the code nor the reward says (open question #11). */
const DEFAULT_VALIDITY_DAYS = 30;

/** When an issued code stops working: its own date, else the reward's validity (§5.1). */
export function codeExpiry(r: RewardConfig, codeExpiresAt: Date | null, now: Date): Date {
  if (codeExpiresAt) return codeExpiresAt;
  if (r.validUntil) return r.validUntil;
  const days = r.validityDays ?? DEFAULT_VALIDITY_DAYS;
  return new Date(now.getTime() + days * 86_400_000);
}
