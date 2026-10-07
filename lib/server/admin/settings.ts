/**
 * Contest settings from the admin (ADM-07, SEC-08): the dates, the leaderboard switch and the
 * retention period. Every change is audited with before and after. Saving a score reads the
 * settings fresh, so a change applies to saves at once; run finishes see it within the
 * campaign cache's few seconds.
 */
import type { Db, Queryable } from "@/db/client";
import { clearCampaignCache } from "../campaign";
import { audit } from "./audit";
import { parseMontrealLocal, toMontrealLocal } from "./time";

export interface CampaignSettingsValue {
  startsAt: Date | null;
  endsAt: Date | null;
  /** The leaderboard switch: off stops every new score at once. */
  leaderboardOpen: boolean;
  retentionDays: number;
}

export async function loadSettings(q: Queryable): Promise<CampaignSettingsValue> {
  const s = await q.campaignSettings.findOne({ _id: 1 });
  return {
    startsAt: s?.startsAt ?? null,
    endsAt: s?.endsAt ?? null,
    leaderboardOpen: s?.leaderboardOpen ?? false,
    retentionDays: s?.retentionDays ?? 90,
  };
}

/** What the settings form posts, as strings. */
export interface SettingsForm {
  startsAt: string;
  endsAt: string;
  leaderboardOpen: boolean;
  retentionDays: string;
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

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      startsAt,
      endsAt,
      leaderboardOpen: form.leaderboardOpen,
      retentionDays: retentionDays!,
    },
  };
}

/** Values as the form shows them. */
export function toForm(v: CampaignSettingsValue): SettingsForm {
  return {
    startsAt: toMontrealLocal(v.startsAt),
    endsAt: toMontrealLocal(v.endsAt),
    leaderboardOpen: v.leaderboardOpen,
    retentionDays: String(v.retentionDays),
  };
}

type Field = keyof CampaignSettingsValue;
type Change = { field: Field; from: unknown; to: unknown };

/** The audit action for a change to each field. */
const ACTION: Record<Field, string> = {
  startsAt: "campaign.dates",
  endsAt: "campaign.dates",
  leaderboardOpen: "campaign.leaderboard",
  retentionDays: "campaign.policy",
};

function diff(before: CampaignSettingsValue, after: CampaignSettingsValue): Change[] {
  const changes: Change[] = [];
  const push = (field: Field, from: unknown, to: unknown) => {
    if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ field, from, to });
  };
  // The form has minute precision; a date set from a script may carry seconds.
  push("startsAt", toMontrealLocal(before.startsAt), toMontrealLocal(after.startsAt));
  push("endsAt", toMontrealLocal(before.endsAt), toMontrealLocal(after.endsAt));
  push("leaderboardOpen", before.leaderboardOpen, after.leaderboardOpen);
  push("retentionDays", before.retentionDays, after.retentionDays);
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
    await tx.campaignSettings.updateOne(
      { _id: 1 },
      {
        $set: {
          startsAt: value.startsAt,
          endsAt: value.endsAt,
          leaderboardOpen: value.leaderboardOpen,
          retentionDays: value.retentionDays,
          updatedAt: now,
          updatedBy: admin,
        },
      },
    );
    for (const c of changes) {
      await audit(tx, admin, ACTION[c.field], c.field, { field: c.field, from: c.from, to: c.to });
    }
  });
  clearCampaignCache();
  return changes.map((c) => c.field);
}
