"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { REWARD_IDS, isRewardId } from "@/game-core";
import { audit } from "@/lib/server/admin/audit";
import { SESSION_COOKIE, requireAdmin } from "@/lib/server/admin/auth";
import {
  erasePlayer,
  queueCouponResend,
  renamePlayer,
  setHidden,
} from "@/lib/server/admin/players";
import {
  MAX_CSV_BYTES,
  importCodes,
  markRedeemed,
  parseEmailList,
  parseThresholds,
  setPoolAlerts,
} from "@/lib/server/admin/pools";
import {
  loadSettings,
  saveSettings,
  validateSettings,
  type SettingsForm,
} from "@/lib/server/admin/settings";
import { db } from "@/lib/server/db";
import { deliverEmail } from "@/lib/server/email/deliver";
import { log } from "@/lib/server/log";
import { done, failed, type ActionState } from "./state";

const uuid = z.uuid();
const text = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === "string" ? v : "";
};

export async function signOut(): Promise<void> {
  const admin = await requireAdmin();
  await audit(db(), admin, "admin.logout");
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/admin/login");
}

// ---------- code pools ----------

async function uploadedText(fd: FormData): Promise<string | ActionState> {
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) return failed("Choose a CSV file first.");
  if (file.size > MAX_CSV_BYTES)
    return failed("That file is over 5 MB. Split it and upload in parts.");
  return file.text();
}

const IMPORT_ERRORS: Record<string, string> = {
  unknown_reward: "Pick a reward.",
  too_large: "That file is over 5 MB. Split it and upload in parts.",
  too_many_rows: "That file has more than 200,000 rows. Split it and upload in parts.",
  empty: "The file has no codes in it. It needs a `code` column, or one code per line.",
};

export async function importCodesAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const reward = text(fd, "reward");
  if (!isRewardId(reward)) return failed("Pick a reward.");
  const csv = await uploadedText(fd);
  if (typeof csv !== "string") return csv;
  const result = await importCodes(db(), reward, csv, { batch: text(fd, "batch") });
  if (!result.ok) return failed(IMPORT_ERRORS[result.error] ?? "The import failed.");
  const s = result.summary;
  await audit(db(), admin, "codes.import", reward, {
    batch: s.batch,
    rows: s.rows,
    imported: s.imported,
    alreadyExist: s.alreadyExist,
    duplicatesInFile: s.duplicatesInFile,
    invalid: s.invalid.length,
  });
  revalidatePath("/admin/codes");
  revalidatePath("/admin");
  const shown = s.invalid
    .slice(0, 10)
    .map(
      (p) =>
        `Line ${p.line}: ${p.reason === "date" ? "bad expiry date" : "not a valid code"} "${p.value}"`,
    );
  if (s.invalid.length > shown.length) shown.push(`…and ${s.invalid.length - shown.length} more.`);
  return done(
    s.imported > 0 ? `Added ${s.imported} codes to the pool.` : "No new codes were added.",
    {
      details: [
        ["Rows in the file", s.rows],
        ["Added", s.imported],
        ["Repeated in the file", s.duplicatesInFile],
        [
          "Already in a pool (skipped)",
          s.alreadyExist + (s.inOtherPool ? ` (${s.inOtherPool} in the other reward's pool)` : ""),
        ],
        ["Unusable rows", s.invalid.length],
        ["Batch", s.batch],
      ],
      items: shown,
    },
  );
}

export async function redeemedReportAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const csv = await uploadedText(fd);
  if (typeof csv !== "string") return csv;
  const result = await markRedeemed(db(), csv);
  if (!result.ok) {
    return failed(
      result.error === "empty" ? "The report has no codes in it." : "That file is over 5 MB.",
    );
  }
  const s = result.summary;
  await audit(db(), admin, "codes.redeemed_report", null, { ...s });
  revalidatePath("/admin/codes");
  revalidatePath("/admin");
  return done(`Marked ${s.marked} codes as redeemed.`, {
    details: [
      ["Rows in the report", s.rows],
      ["Marked redeemed", s.marked],
      ["Already marked", s.alreadyRedeemed],
      ["Never issued to a player", s.notIssued],
      ["Not in any pool", s.unknown],
      ["Unusable rows", s.invalid],
    ],
  });
}

export async function saveAlertsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const emails = parseEmailList(text(fd, "emails"));
  if (emails === null) return failed("Alert recipients must be valid email addresses.");
  const thresholds: Record<string, number[]> = {};
  for (const id of REWARD_IDS) {
    const parsed = parseThresholds(text(fd, `thresholds_${id}`));
    if (!parsed) {
      return failed(`${id}: enter up to 5 percentages from 1 to 99, such as "20, 5".`);
    }
    thresholds[id] = parsed;
  }
  await db().transaction(async (tx) => {
    for (const id of REWARD_IDS) await setPoolAlerts(tx, id, thresholds[id]);
    await tx.campaignSettings.updateOne(
      { _id: 1 },
      { $set: { alertEmails: emails, updatedAt: new Date(), updatedBy: admin } },
    );
    await audit(tx, admin, "pool.alerts", null, { thresholds, recipients: emails });
  });
  revalidatePath("/admin/codes");
  return done("Alert settings saved.");
}

// ---------- campaign ----------

export async function saveCampaignAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const current = await loadSettings(db());
  const reward = (id: (typeof REWARD_IDS)[number]) => ({
    active: fd.get(`${id}_active`) === "on",
    threshold: text(fd, `${id}_threshold`),
    validityDays: text(fd, `${id}_validity`),
  });
  const form: SettingsForm = {
    startsAt: text(fd, "startsAt"),
    endsAt: text(fd, "endsAt"),
    claimsEnabled: fd.get("claimsEnabled") === "on",
    retentionDays: text(fd, "retentionDays"),
    // Recipients live on the code pools page; keep what is saved.
    alertEmails: current.alertEmails.join(", "),
    rewards: { free_coke: reward("free_coke"), free_garlic_sauce: reward("free_garlic_sauce") },
  };
  const checked = validateSettings(form);
  if (!checked.ok) return failed("Nothing was saved. Fix these first:", { items: checked.errors });
  const changed = await saveSettings(db(), admin, checked.value);
  revalidatePath("/admin/campaign");
  revalidatePath("/admin");
  if (changed.length === 0) return done("Nothing changed.");
  const thresholdChanged = changed.some((f) => f.endsWith(".threshold"));
  return done(`Saved ${changed.length} ${changed.length === 1 ? "change" : "changes"}.`, {
    items: [
      "Switches (claims on or off, reward on or off) apply to claims right away.",
      ...(thresholdChanged
        ? [
            "New thresholds apply to runs started from now on. Runs already in progress keep the old ones.",
          ]
        : []),
    ],
  });
}

// ---------- players and moderation ----------

export async function resendCouponAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const id = uuid.safeParse(text(fd, "id"));
  if (!id.success) return failed("Unknown player.");
  const emailId = await queueCouponResend(db(), id.data);
  if (!emailId) return failed("Nothing to send: no codes, or the address is blocked.");
  await audit(db(), admin, "player.resend", id.data);
  after(() =>
    deliverEmail(db(), emailId).catch((error) =>
      log.error("email_after_failed", error, { emailId }),
    ),
  );
  revalidatePath(`/admin/players/${id.data}`);
  return done("Coupon email queued. It goes out in a few seconds.");
}

export async function setHiddenAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const id = uuid.safeParse(text(fd, "id"));
  if (!id.success) return failed("Unknown player.");
  const hidden = text(fd, "hidden") === "1";
  if (!(await setHidden(db(), id.data, hidden))) return failed("Player not found.");
  await audit(db(), admin, hidden ? "player.hide" : "player.unhide", id.data);
  revalidatePath("/admin/moderation");
  revalidatePath(`/admin/players/${id.data}`);
  return done(hidden ? "Hidden from the leaderboard." : "Back on the leaderboard.");
}

export async function renameAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const id = uuid.safeParse(text(fd, "id"));
  if (!id.success) return failed("Unknown player.");
  const name = await renamePlayer(db(), id.data, text(fd, "name"));
  if (name === null) {
    return failed(
      "Use 2 to 16 letters, numbers, spaces or - _ . ' (or leave blank for a new food name).",
    );
  }
  await audit(db(), admin, "player.rename", id.data, { nickname: name });
  revalidatePath("/admin/moderation");
  revalidatePath(`/admin/players/${id.data}`);
  return done(`Renamed to "${name}".`);
}

export async function erasePlayerAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const id = uuid.safeParse(text(fd, "id"));
  if (!id.success) return failed("Unknown player.");
  if (text(fd, "confirm").trim() !== "ERASE") return failed("Type ERASE to confirm.");
  const result = await erasePlayer(db(), id.data);
  if (!result) return failed("Player not found, or already erased.");
  await audit(db(), admin, "player.erase", id.data, { ...result });
  revalidatePath("/admin/players");
  revalidatePath("/admin/moderation");
  revalidatePath("/admin");
  redirect("/admin/players?erased=1");
}
