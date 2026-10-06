/**
 * Campaign settings from the admin (ADM-07, SEC-08): dates, the global claims switch, each
 * reward's active flag, threshold and code validity, retention and alert recipients. Every
 * change is audited with before and after. Thresholds reach only runs started afterwards (they
 * travel in the run token); switches act on claims at once.
 */
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { campaignSettings, rewards } from "@/db/schema";
import { REWARD_IDS, type RewardId } from "@/game-core";
import { clearCampaignCache } from "../campaign";
import { audit } from "./audit";
import { parseEmailList } from "./pools";
import { parseMontrealLocal, toMontrealLocal } from "./time";

export interface RewardSettings {
  active: boolean;
  /** Metres for free_coke, garlic for free_garlic_sauce. */
  threshold: number;
  validityDays: number | null;
}

export interface CampaignSettingsValue {
  startsAt: Date | null;
  endsAt: Date | null;
  claimsEnabled: boolean;
  retentionDays: number;
  alertEmails: string[];
  rewards: Record<RewardId, RewardSettings>;
}

export const LIMITS = {
  free_coke: { min: 10, max: 1000, unit: "m" },
  free_garlic_sauce: { min: 1, max: 50, unit: "garlic" },
} as const;

export async function loadSettings(q: Db): Promise<CampaignSettingsValue> {
  const [s] = await q.select().from(campaignSettings).where(eq(campaignSettings.id, 1));
  const rows = await q.select().from(rewards);
  const out = {} as Record<RewardId, RewardSettings>;
  for (const id of REWARD_IDS) {
    const row = rows.find((r) => r.id === id);
    const rule = (row?.rule ?? {}) as { distanceM?: number; garlic?: number };
    out[id] = {
      active: row?.active ?? false,
      threshold: (id === "free_coke" ? rule.distanceM : rule.garlic) ?? 0,
      validityDays: row?.validityDays ?? null,
    };
  }
  return {
    startsAt: s?.startsAt ?? null,
    endsAt: s?.endsAt ?? null,
    claimsEnabled: s?.claimsEnabled ?? false,
    retentionDays: s?.retentionDays ?? 90,
    alertEmails: s?.alertEmails ?? [],
    rewards: out,
  };
}

/** What the settings form posts, as strings. */
export interface SettingsForm {
  startsAt: string;
  endsAt: string;
  claimsEnabled: boolean;
  retentionDays: string;
  alertEmails: string;
  rewards: Record<RewardId, { active: boolean; threshold: string; validityDays: string }>;
}

export type ValidatedSettings =
  { ok: true; value: CampaignSettingsValue } | { ok: false; errors: string[] };

const wholeNumber = (v: string) => (/^\d{1,6}$/.test(v.trim()) ? Number(v.trim()) : null);

export function validateSettings(form: SettingsForm): ValidatedSettings {
  const errors: string[] = [];
  const date = (raw: string, label: string) => {
    if (raw.trim() === "") return null;
    const d = parseMontrealLocal(raw);
    if (!d) errors.push(`${label} isn't a valid date and time.`);
    return d;
  };
  const startsAt = date(form.startsAt, "The start");
  const endsAt = date(form.endsAt, "The end");
  if (startsAt && endsAt && endsAt <= startsAt) errors.push("The end must be after the start.");

  const retentionDays = wholeNumber(form.retentionDays);
  if (retentionDays === null || retentionDays < 1 || retentionDays > 3650) {
    errors.push("Retention is a whole number of days, 1 to 3650.");
  }

  const alertEmails = parseEmailList(form.alertEmails);
  if (alertEmails === null) errors.push("Alert recipients must be valid email addresses.");

  const out = {} as Record<RewardId, RewardSettings>;
  for (const id of REWARD_IDS) {
    const f = form.rewards[id];
    const limit = LIMITS[id];
    const threshold = wholeNumber(f.threshold);
    if (threshold === null || threshold < limit.min || threshold > limit.max) {
      errors.push(`${id}: the threshold is a whole number from ${limit.min} to ${limit.max}.`);
    }
    const validity = wholeNumber(f.validityDays);
    if (validity === null || validity < 1 || validity > 365) {
      errors.push(`${id}: code validity is 1 to 365 days.`);
    }
    out[id] = { active: f.active, threshold: threshold ?? 0, validityDays: validity };
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      startsAt,
      endsAt,
      claimsEnabled: form.claimsEnabled,
      retentionDays: retentionDays!,
      alertEmails: alertEmails!,
      rewards: out,
    },
  };
}

/** Values as the form shows them. */
export function toForm(v: CampaignSettingsValue): SettingsForm {
  const rewardForm = (id: RewardId) => ({
    active: v.rewards[id].active,
    threshold: String(v.rewards[id].threshold),
    validityDays: String(v.rewards[id].validityDays ?? ""),
  });
  return {
    startsAt: toMontrealLocal(v.startsAt),
    endsAt: toMontrealLocal(v.endsAt),
    claimsEnabled: v.claimsEnabled,
    retentionDays: String(v.retentionDays),
    alertEmails: v.alertEmails.join(", "),
    rewards: {
      free_coke: rewardForm("free_coke"),
      free_garlic_sauce: rewardForm("free_garlic_sauce"),
    },
  };
}

type Change = { field: string; from: unknown; to: unknown };

function diff(before: CampaignSettingsValue, after: CampaignSettingsValue): Change[] {
  const changes: Change[] = [];
  const push = (field: string, from: unknown, to: unknown) => {
    if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ field, from, to });
  };
  // The form has minute precision; a date set from a script may carry seconds.
  push("startsAt", toMontrealLocal(before.startsAt), toMontrealLocal(after.startsAt));
  push("endsAt", toMontrealLocal(before.endsAt), toMontrealLocal(after.endsAt));
  push("claimsEnabled", before.claimsEnabled, after.claimsEnabled);
  push("retentionDays", before.retentionDays, after.retentionDays);
  push("alertEmails", before.alertEmails, after.alertEmails);
  for (const id of REWARD_IDS) {
    push(`${id}.active`, before.rewards[id].active, after.rewards[id].active);
    push(`${id}.threshold`, before.rewards[id].threshold, after.rewards[id].threshold);
    push(`${id}.validityDays`, before.rewards[id].validityDays, after.rewards[id].validityDays);
  }
  return changes;
}

/** Saves what changed and logs it. Returns the fields that changed (none: nothing written). */
export async function saveSettings(
  q: Db,
  admin: string,
  value: CampaignSettingsValue,
  now = new Date(),
): Promise<string[]> {
  const before = await loadSettings(q);
  const changes = diff(before, value);
  if (changes.length === 0) return [];
  await q.transaction(async (tx) => {
    await tx
      .update(campaignSettings)
      .set({
        startsAt: value.startsAt,
        endsAt: value.endsAt,
        claimsEnabled: value.claimsEnabled,
        retentionDays: value.retentionDays,
        alertEmails: value.alertEmails,
        updatedAt: now,
        updatedBy: admin,
      })
      .where(eq(campaignSettings.id, 1));
    for (const id of REWARD_IDS) {
      const r = value.rewards[id];
      await tx
        .update(rewards)
        .set({
          active: r.active,
          rule: id === "free_coke" ? { distanceM: r.threshold } : { garlic: r.threshold },
          validityDays: r.validityDays,
          updatedAt: now,
        })
        .where(eq(rewards.id, id));
    }
    for (const c of changes) {
      const action = c.field.endsWith(".active")
        ? "reward.active"
        : c.field.endsWith(".threshold")
          ? "reward.threshold"
          : c.field.endsWith(".validityDays")
            ? "reward.validity"
            : c.field === "claimsEnabled"
              ? "campaign.claims"
              : c.field === "retentionDays" || c.field === "alertEmails"
                ? "campaign.policy"
                : "campaign.dates";
      await audit(tx, admin, action, c.field.split(".")[0], {
        field: c.field,
        from: c.from,
        to: c.to,
      });
    }
  });
  clearCampaignCache();
  return changes.map((c) => c.field);
}
