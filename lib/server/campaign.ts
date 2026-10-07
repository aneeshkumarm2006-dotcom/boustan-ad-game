/**
 * Contest settings, read from the database so they change without a redeploy (SEC-08, ADM-07).
 * Run starts read a copy cached for a few seconds per instance (500 starts/s, NFR-04); saving a
 * score always reads fresh, so the leaderboard switch takes effect at once.
 *
 * Scores count towards the leaderboard while the contest window is open and the leaderboard
 * switch is on. Outside that, the game can still be played, but nothing is saved or ranked.
 */
import type { Queryable } from "@/db/client";
import type { CampaignState } from "@/lib/api/types";
import { db } from "./db";

export interface Campaign {
  startsAt: Date | null;
  endsAt: Date | null;
  /** The leaderboard switch (SEC-08). */
  leaderboardOpen: boolean;
}

export async function loadCampaign(q: Queryable): Promise<Campaign> {
  const settings = await q.campaignSettings.findOne({ _id: 1 });
  return {
    startsAt: settings?.startsAt ?? null,
    endsAt: settings?.endsAt ?? null,
    leaderboardOpen: settings?.leaderboardOpen ?? false,
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

/** Whether a score counts towards the leaderboard right now: window open and switch on. */
export function boardOpen(c: Campaign, now: Date): boolean {
  return c.leaderboardOpen && campaignStatus(c, now) === "active";
}

/** What the start screen needs: status, dates and the leaderboard switch. */
export function campaignState(c: Campaign, now: Date): CampaignState {
  return {
    status: campaignStatus(c, now),
    startsAt: c.startsAt?.toISOString() ?? null,
    endsAt: c.endsAt?.toISOString() ?? null,
    leaderboardOpen: c.leaderboardOpen,
  };
}
