"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/server/admin/audit";
import { SESSION_COOKIE, requireAdmin } from "@/lib/server/admin/auth";
import { erasePlayer, renamePlayer, setHidden } from "@/lib/server/admin/players";
import { saveSettings, validateSettings, type SettingsForm } from "@/lib/server/admin/settings";
import { db } from "@/lib/server/db";
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

// ---------- campaign ----------

export async function saveCampaignAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const form: SettingsForm = {
    startsAt: text(fd, "startsAt"),
    endsAt: text(fd, "endsAt"),
    leaderboardOpen: fd.get("leaderboardOpen") === "on",
    retentionDays: text(fd, "retentionDays"),
  };
  const checked = validateSettings(form);
  if (!checked.ok) return failed("Nothing was saved. Fix these first:", { items: checked.errors });
  const changed = await saveSettings(db(), admin, checked.value);
  revalidatePath("/admin/campaign");
  revalidatePath("/admin/leaderboard");
  revalidatePath("/admin");
  if (changed.length === 0) return done("Nothing changed.");
  return done(`Saved ${changed.length} ${changed.length === 1 ? "change" : "changes"}.`, {
    items: ["The game follows the new settings within a few seconds."],
  });
}

// ---------- players and the leaderboard ----------

export async function setHiddenAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const id = uuid.safeParse(text(fd, "id"));
  if (!id.success) return failed("Unknown player.");
  const hidden = text(fd, "hidden") === "1";
  if (!(await setHidden(db(), id.data, hidden))) return failed("Player not found.");
  await audit(db(), admin, hidden ? "player.hide" : "player.unhide", id.data);
  revalidatePath("/admin/leaderboard");
  revalidatePath("/admin");
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
  revalidatePath("/admin/leaderboard");
  revalidatePath("/admin");
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
  revalidatePath("/admin/leaderboard");
  revalidatePath("/admin");
  redirect("/admin/players?erased=1");
}
