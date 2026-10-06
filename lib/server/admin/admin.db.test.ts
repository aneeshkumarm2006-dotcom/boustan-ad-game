import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  adminAudit,
  bestRuns,
  campaignSettings,
  codes,
  consents,
  emailOutbox,
  playerTokens,
  players,
  rewards,
  runs,
} from "@/db/schema";
import { parseCsv } from "@/lib/csv";
import { BOTH, NOTHING, addCodes, connect, finish, resetDb, seedCampaign } from "@/tests/db";
import { clearBoardCache, rankOfPlayer, topEntries } from "../leaderboard";
import { claimRewards } from "../claims";
import { audit } from "./audit";
import { claimersCsv } from "./export";
import {
  erasePlayer,
  exportPlayer,
  playerDetail,
  queueCouponResend,
  renamePlayer,
  searchPlayers,
  setHidden,
} from "./players";
import { importCodes, markRedeemed, poolStats, setPoolAlerts } from "./pools";
import { runRetention, retentionDue } from "./retention";
import { loadSettings, saveSettings, toForm, validateSettings } from "./settings";
import { runStockAlerts } from "./stock-alerts";
import type { OutgoingEmail } from "../email/sender";

const { db, close } = connect();
afterAll(close);
beforeEach(async () => {
  await resetDb(db);
  await seedCampaign(db, { codesPerReward: 10 });
  clearBoardCache();
});

let seed = 100;
async function claimPlayer(email: string, opts: { optIn?: boolean; nickname?: string } = {}) {
  const run = await finish(db, BOTH(seed++));
  const res = await claimRewards(
    db,
    {
      claimToken: run.claimToken!,
      email,
      nickname: opts.nickname,
      lang: "en",
      termsAge: true,
      marketingOptIn: opts.optIn ?? false,
      src: "partner-a",
      utm: { utm_campaign: "launch" },
    },
    { ip: "203.0.113.9", userAgent: "vitest-agent", now: new Date() },
  );
  if (!res.ok) throw new Error(`claim failed: ${res.error}`);
  return res;
}

describe("code pool import (RWD-02)", () => {
  it("imports new codes, trims, de-dupes, rejects existing ones and summarizes", async () => {
    const csv = [
      "code,expires_at,batch",
      "NEW-1,,b1",
      " NEW-2 ,,b1",
      "NEW-1,,b1",
      "C-COKE-0000,,b1",
      "x,,",
    ].join("\n");
    const res = await importCodes(db, "free_coke", csv);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.summary).toMatchObject({
      rows: 5,
      imported: 2,
      duplicatesInFile: 1,
      alreadyExist: 1,
      inOtherPool: 0,
    });
    expect(res.summary.invalid).toEqual([{ line: 6, value: "x", reason: "format" }]);
    const rows = await db.select().from(codes).where(eq(codes.rewardId, "free_coke"));
    expect(rows).toHaveLength(12);
    expect(rows.find((r) => r.code === "NEW-2")?.batch).toBe("b1");
  });

  it("flags a code that already sits in the other reward's pool, and leaves it there", async () => {
    const res = await importCodes(db, "free_coke", "C-GARL-0000\nFRESH-1\n");
    expect(res.ok && res.summary).toMatchObject({ imported: 1, alreadyExist: 1, inOtherPool: 1 });
    const [row] = await db.select().from(codes).where(eq(codes.code, "C-GARL-0000"));
    expect(row.rewardId).toBe("free_garlic_sauce");
  });

  it("names the batch when the file doesn't, and refuses an unknown reward or an empty file", async () => {
    const res = await importCodes(db, "free_coke", "ONLY-1\n", {
      now: new Date("2026-10-15T14:30:00Z"),
    });
    expect(res.ok && res.summary.batch).toBe("import-202610151430");
    const [row] = await db.select().from(codes).where(eq(codes.code, "ONLY-1"));
    expect(row.batch).toBe("import-202610151430");
    expect(await importCodes(db, "free_pizza", "A-1\n")).toEqual({
      ok: false,
      error: "unknown_reward",
    });
    expect(await importCodes(db, "free_coke", "code\n")).toEqual({ ok: false, error: "empty" });
  });

  it("imports a large file in chunks", async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `BULK-${String(i).padStart(5, "0")}`);
    const res = await importCodes(db, "free_garlic_sauce", lines.join("\n"));
    expect(res.ok && res.summary.imported).toBe(5000);
  });

  it("two imports of the same file at once add each code once", async () => {
    const csv = Array.from({ length: 300 }, (_, i) => `RACE-${i}`).join("\n");
    const [a, b] = await Promise.all([
      importCodes(db, "free_coke", csv),
      importCodes(db, "free_coke", csv),
    ]);
    expect(a.ok && b.ok).toBe(true);
    const imported = (a.ok ? a.summary.imported : 0) + (b.ok ? b.summary.imported : 0);
    expect(imported).toBe(300);
    const rows = await db
      .select()
      .from(codes)
      .where(sql`${codes.code} like 'RACE-%'`);
    expect(rows).toHaveLength(300);
  });

  it("reports counts by status and the redemption rate", async () => {
    await claimPlayer("a@example.com");
    const before = await poolStats(db);
    const coke = before.find((p) => p.reward === "free_coke")!;
    expect(coke).toMatchObject({ total: 10, available: 9, assigned: 1, redeemed: 0 });
    expect(coke.redemptionRate).toBe(0);
    const [assigned] = await db.select().from(codes).where(eq(codes.status, "assigned"));
    const res = await markRedeemed(db, `code,redeemed_at\n${assigned.code},2026-10-16T12:00\n`);
    expect(res.ok && res.summary.marked).toBe(1);
    const after = (await poolStats(db)).find((p) => p.reward === assigned.rewardId)!;
    expect(after.redeemed).toBe(1);
    expect(after.redemptionRate).toBe(1);
  });
});

describe("uEat redeemed report (ADM-08)", () => {
  it("marks issued codes, and counts repeats, unissued and unknown codes", async () => {
    await claimPlayer("a@example.com");
    const issued = await db.select().from(codes).where(eq(codes.status, "assigned"));
    expect(issued).toHaveLength(2);
    const csv = [
      "code",
      issued[0].code,
      issued[0].code,
      issued[1].code,
      "C-COKE-0009",
      "NOPE-1",
      "!",
    ].join("\n");
    const res = await markRedeemed(db, csv);
    expect(res.ok && res.summary).toEqual({
      rows: 6,
      marked: 2,
      alreadyRedeemed: 0,
      notIssued: 1,
      unknown: 1,
      invalid: 1,
    });
    const again = await markRedeemed(db, `code\n${issued[0].code}\n`);
    expect(again.ok && again.summary.alreadyRedeemed).toBe(1);
  });
});

describe("low-stock emails (RWD-04)", () => {
  const sent: OutgoingEmail[] = [];
  const send = async (e: OutgoingEmail) => {
    sent.push(e);
    return { id: "t" };
  };
  beforeEach(async () => {
    sent.length = 0;
    await db.update(campaignSettings).set({ alertEmails: ["ops@example.com", "boss@example.com"] });
  });
  const take = (reward: "free_coke" | "free_garlic_sauce", n: number) =>
    db
      .update(codes)
      .set({ status: "assigned" })
      .where(
        sql`${codes.id} in (select id from codes where reward_id = ${reward} and status = 'available' order by id limit ${n})`,
      );

  it("sends nothing while stock is healthy", async () => {
    await runStockAlerts(db, send);
    expect(sent).toEqual([]);
  });

  it("announces each threshold once, to every recipient", async () => {
    await take("free_coke", 8); // 2 of 10 left: 20%
    const first = await runStockAlerts(db, send);
    expect(first.find((r) => r.reward === "free_coke")?.announced).toBe(20);
    expect(sent.map((e) => e.to).sort()).toEqual(["boss@example.com", "ops@example.com"]);
    expect(sent[0].subject).toContain("2 left");
    expect(sent[0].text).toContain("/admin/codes");

    await runStockAlerts(db, send);
    expect(sent).toHaveLength(2); // same level, no repeat

    await take("free_coke", 1); // 1 of 10 left: 10%, still the 20 level
    await runStockAlerts(db, send);
    expect(sent).toHaveLength(2);

    await take("free_coke", 1); // none left: 5% level
    const last = await runStockAlerts(db, send);
    expect(last.find((r) => r.reward === "free_coke")?.announced).toBe(5);
    expect(sent).toHaveLength(4);
  });

  it("re-arms after codes are added", async () => {
    await take("free_coke", 9);
    await runStockAlerts(db, send);
    expect(sent).toHaveLength(2);
    await addCodes(db, "free_coke", 100, "MORE");
    await runStockAlerts(db, send);
    const [coke] = await db.select().from(rewards).where(eq(rewards.id, "free_coke"));
    expect(coke.alertLevel).toBeNull();
    await db
      .update(codes)
      .set({ status: "void" })
      .where(sql`${codes.code} like 'MORE-%'`);
    await runStockAlerts(db, send);
    expect(sent.length).toBeGreaterThan(2);
  });

  it("uses the thresholds an admin sets, and falls back to ADMIN_EMAILS when no recipients are set", async () => {
    await setPoolAlerts(db, "free_garlic_sauce", [60]);
    await db.update(campaignSettings).set({ alertEmails: [] });
    process.env.ADMIN_EMAILS = "owner@example.com";
    const { resetEnvForTests } = await import("../env");
    resetEnvForTests();
    try {
      await take("free_garlic_sauce", 5); // 50% left
      await runStockAlerts(db, send);
      expect(sent.map((e) => e.to)).toEqual(["owner@example.com"]);
    } finally {
      delete process.env.ADMIN_EMAILS;
      resetEnvForTests();
    }
  });

  it("keeps trying when the email fails", async () => {
    await take("free_coke", 9);
    const failing = async () => {
      throw new Error("provider down");
    };
    const res = await runStockAlerts(db, failing);
    expect(res.find((r) => r.reward === "free_coke")?.announced).toBeNull();
    const [coke] = await db.select().from(rewards).where(eq(rewards.id, "free_coke"));
    expect(coke.alertLevel).toBeNull();
    await runStockAlerts(db, send);
    expect(sent.length).toBeGreaterThan(0);
  });
});

describe("players (ADM-04)", () => {
  it("searches by email or nickname, literally, and shows claim counts", async () => {
    await claimPlayer("marie.tremblay@example.com", { nickname: "Marie T" });
    await claimPlayer("omar@example.com", { nickname: "Omar 100" });
    expect((await searchPlayers(db, "tremblay")).map((p) => p.nickname)).toEqual(["Marie T"]);
    expect((await searchPlayers(db, "OMAR")).map((p) => p.email)).toEqual(["omar@example.com"]);
    expect((await searchPlayers(db, "100")).map((p) => p.nickname)).toEqual(["Omar 100"]);
    expect(await searchPlayers(db, "%")).toHaveLength(0); // % is not a wildcard
    expect(await searchPlayers(db, "")).toHaveLength(2);
    expect((await searchPlayers(db, "omar"))[0].claimCount).toBe(2);
  });

  it("shows runs, claims with codes, consents and emails for one player", async () => {
    const { playerId } = await claimPlayer("full@example.com", { optIn: true });
    const detail = await playerDetail(db, playerId);
    expect(detail?.runs).toHaveLength(1);
    expect(detail?.claims.map((c) => c.reward).sort()).toEqual(["free_coke", "free_garlic_sauce"]);
    expect(detail?.claims.every((c) => c.code)).toBe(true);
    expect(detail?.consents.map((c) => c.kind).sort()).toEqual(["marketing", "terms_age"]);
    expect(detail?.emails).toHaveLength(1);
    expect(detail?.devices).toBe(1);
    expect(await playerDetail(db, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("queues a resend of every code the player holds", async () => {
    const { playerId } = await claimPlayer("again@example.com");
    const id = await queueCouponResend(db, playerId);
    expect(id).not.toBeNull();
    const [row] = await db.select().from(emailOutbox).where(eq(emailOutbox.id, id!));
    expect(row).toMatchObject({ kind: "resend", playerId });
    expect(row.claimIds).toHaveLength(2);
    await db.update(players).set({ emailBlockedAt: new Date() }).where(eq(players.id, playerId));
    expect(await queueCouponResend(db, playerId)).toBeNull();
  });

  it("exports everything held about a player", async () => {
    const { playerId } = await claimPlayer("export@example.com", { nickname: "Exporter" });
    const data = await exportPlayer(db, playerId);
    expect(data?.player).toMatchObject({ email: "export@example.com", nickname: "Exporter" });
    expect(data?.claims).toHaveLength(2);
    expect(data?.consents.length).toBeGreaterThan(0);
    expect(JSON.stringify(data)).not.toContain("tokenHash");
  });
});

describe("erasing a player (DATA-07)", () => {
  it("removes personal data, consents, devices and the leaderboard row, and keeps anonymous totals", async () => {
    const { playerId } = await claimPlayer("gone@example.com", { optIn: true, nickname: "Goner" });
    const other = await claimPlayer("stays@example.com", { nickname: "Stayer" });
    expect(await topEntries(db, 10)).toHaveLength(2);

    const res = await erasePlayer(db, playerId);
    expect(res).toMatchObject({ consentRows: 2, devices: 1 });

    const [p] = await db.select().from(players).where(eq(players.id, playerId));
    expect(p.email).toContain("@erased.invalid");
    expect(p.email).not.toContain("gone@");
    expect(p).toMatchObject({ nickname: null, marketingOptIn: false });
    expect(p.deletedAt).not.toBeNull();
    expect(await db.select().from(consents).where(eq(consents.playerId, playerId))).toEqual([]);
    expect(await db.select().from(playerTokens).where(eq(playerTokens.playerId, playerId))).toEqual(
      [],
    );
    expect(await db.select().from(bestRuns).where(eq(bestRuns.playerId, playerId))).toEqual([]);
    expect((await topEntries(db, 10)).map((e) => e.name)).toEqual(["Stayer"]);
    // Anonymous totals: runs and issued codes are still counted.
    expect(await db.select().from(runs).where(eq(runs.playerId, playerId))).toHaveLength(1);
    const stock = await poolStats(db);
    expect(stock.find((s) => s.reward === "free_coke")?.assigned).toBe(2);
    // The other player is untouched.
    expect(
      (await db.select().from(consents).where(eq(consents.playerId, other.playerId))).length,
    ).toBe(1);
    // Erasing twice does nothing.
    expect(await erasePlayer(db, playerId)).toBeNull();
    // The address can be used again by a new player.
    await claimPlayer("gone@example.com");
    expect(await searchPlayers(db, "gone@")).toHaveLength(1);
  });

  it("stops queued emails", async () => {
    const { playerId } = await claimPlayer("queued@example.com");
    await erasePlayer(db, playerId);
    const rows = await db.select().from(emailOutbox).where(eq(emailOutbox.playerId, playerId));
    expect(rows.every((r) => r.status === "blocked")).toBe(true);
  });

  it("the consent log still refuses deletes outside a purge", async () => {
    const { playerId } = await claimPlayer("log@example.com");
    await expect(db.delete(consents).where(eq(consents.playerId, playerId))).rejects.toThrow();
  });
});

describe("moderation (LB-07)", () => {
  it("hides and renames entries, and a hidden player stays hidden with the same email", async () => {
    const { playerId } = await claimPlayer("troll@example.com", { nickname: "Troll" });
    await claimPlayer("nice@example.com", { nickname: "Nice" });
    expect((await topEntries(db, 10)).map((e) => e.name).sort()).toEqual(["Nice", "Troll"]);

    expect(await renamePlayer(db, playerId, "Better Name")).toBe("Better Name");
    expect(await renamePlayer(db, playerId, "<script>")).toBeNull();
    expect(await setHidden(db, playerId, true)).toBe(true);
    expect((await topEntries(db, 10)).map((e) => e.name)).toEqual(["Nice"]);

    // Coming back with the same email (any spelling) finds the same hidden player.
    const again = await claimPlayer("T.R.O.L.L+x@example.com");
    expect(again.playerId).not.toBe(playerId); // not gmail: dots matter, so this is a new player
    const same = await claimPlayer("troll+again@example.com");
    expect(same.playerId).toBe(playerId);
    expect(await rankOfPlayer(db, playerId)).toBeNull();
    expect((await topEntries(db, 10)).map((e) => e.name)).not.toContain("Better Name");

    await setHidden(db, playerId, false);
    expect((await topEntries(db, 10)).map((e) => e.name)).toContain("Better Name");
  });

  it("a blank rename gives a new food name", async () => {
    const { playerId } = await claimPlayer("blank@example.com", { nickname: "Old" });
    const name = await renamePlayer(db, playerId, "  ");
    expect(name).toMatch(/^\S+ \S+ \d+$/);
  });
});

describe("campaign settings (ADM-07)", () => {
  it("validates dates, thresholds, validity, retention and recipients", async () => {
    const form = toForm(await loadSettings(db));
    expect(validateSettings(form).ok).toBe(true);
    const bad = validateSettings({
      ...form,
      startsAt: "2026-11-01T00:00",
      endsAt: "2026-10-01T00:00",
      retentionDays: "0",
      alertEmails: "nope",
      rewards: {
        free_coke: { ...form.rewards.free_coke, threshold: "5" },
        free_garlic_sauce: { ...form.rewards.free_garlic_sauce, validityDays: "0" },
      },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toHaveLength(5);
  });

  it("saves only what changed, with before and after in the audit log", async () => {
    const form = toForm(await loadSettings(db));
    const next = validateSettings({
      ...form,
      claimsEnabled: false,
      startsAt: "2026-10-15T00:00",
      endsAt: "2026-11-15T23:59",
      alertEmails: "ops@example.com",
      rewards: {
        ...form.rewards,
        free_coke: { active: true, threshold: "150", validityDays: "14" },
      },
    });
    if (!next.ok) throw new Error(next.errors.join());
    const changed = await saveSettings(db, "admin@example.com", next.value);
    expect(changed.sort()).toEqual(
      [
        "alertEmails",
        "claimsEnabled",
        "endsAt",
        "free_coke.threshold",
        "free_coke.validityDays",
        "startsAt",
      ].sort(),
    );
    const after = await loadSettings(db);
    expect(after.claimsEnabled).toBe(false);
    expect(after.rewards.free_coke).toMatchObject({ threshold: 150, validityDays: 14 });
    expect(after.startsAt?.toISOString()).toBe("2026-10-15T04:00:00.000Z");
    expect(after.endsAt?.toISOString()).toBe("2026-11-16T04:59:00.000Z");
    expect(after.rewards.free_garlic_sauce.threshold).toBe(10);

    const log = await db.select().from(adminAudit);
    expect(log).toHaveLength(6);
    expect(log.every((r) => r.adminEmail === "admin@example.com")).toBe(true);
    const threshold = log.find((r) => r.action === "reward.threshold");
    expect(threshold?.details).toMatchObject({ field: "free_coke.threshold", from: 100, to: 150 });

    expect(await saveSettings(db, "admin@example.com", next.value)).toEqual([]);
    expect(await db.select().from(adminAudit)).toHaveLength(6);
  });

  it("applies new thresholds to new run tokens only", async () => {
    const { startRun } = await import("../runs");
    const { runTokenSchema, verifyToken } = await import("../tokens");
    const { clearCampaignCache } = await import("../campaign");
    const old = await startRun({ src: null, lang: "en", utm: {}, host: null });
    const form = toForm(await loadSettings(db));
    const next = validateSettings({
      ...form,
      rewards: { ...form.rewards, free_coke: { ...form.rewards.free_coke, threshold: "250" } },
    });
    if (!next.ok) throw new Error(next.errors.join());
    await saveSettings(db, "admin@example.com", next.value);
    clearCampaignCache();
    const fresh = await startRun({ src: null, lang: "en", utm: {}, host: null });
    expect(verifyToken("run", old.token, runTokenSchema)?.rules.distanceM).toBe(100);
    expect(verifyToken("run", fresh.token, runTokenSchema)?.rules.distanceM).toBe(250);
  });

  it("writes audit rows for admin actions", async () => {
    await audit(db, "admin@example.com", "codes.import", "free_coke", { imported: 3 });
    const [row] = await db.select().from(adminAudit);
    expect(row).toMatchObject({ action: "codes.import", target: "free_coke" });
  });
});

describe("claimers export (ADM-06, CRM-02)", () => {
  it("has a row per claimer with the consent fields, and can be limited to opted-in players", async () => {
    await claimPlayer("optin@example.com", { optIn: true, nickname: "Opt In" });
    await claimPlayer("optout@example.com");
    // A player who only saved a score has no claim, so isn't a claimer.
    const saved = await finish(db, BOTH(7777));
    await claimRewards(
      db,
      {
        claimToken: saved.claimToken!,
        email: "optin@example.com",
        lang: "en",
        termsAge: true,
        marketingOptIn: false,
        src: null,
        utm: {},
      },
      { ip: null, userAgent: null, now: new Date() },
    );

    // "Save my score" with nothing unlocked: a player, but not a claimer.
    const nothing = await finish(db, NOTHING(8888));
    await claimRewards(
      db,
      {
        claimToken: nothing.claimToken!,
        email: "saveonly@example.com",
        lang: "en",
        termsAge: true,
        marketingOptIn: true,
        src: null,
        utm: {},
      },
      { ip: null, userAgent: null, now: new Date() },
    );
    expect((await searchPlayers(db, "saveonly"))[0].claimCount).toBe(0);

    const all = parseCsv(await claimersCsv(db, false));
    const head = all[0];
    const col = (row: string[], name: string) => row[head.indexOf(name)];
    expect(all).toHaveLength(3);
    const optin = all.find((r) => col(r, "email") === "optin@example.com")!;
    expect(col(optin, "marketing_opt_in")).toBe("yes");
    expect(col(optin, "marketing_status")).toBe("granted");
    expect(col(optin, "marketing_text")).toContain("Boustan");
    expect(col(optin, "marketing_text_version")).not.toBe("");
    expect(col(optin, "marketing_ip")).toBe("203.0.113.9");
    expect(col(optin, "marketing_source")).toBe("claim_form");
    expect(col(optin, "terms_age_accepted_at")).not.toBe("");
    expect(col(optin, "rewards")).toBe("free_coke; free_garlic_sauce");
    expect(col(optin, "codes")).toMatch(/free_coke:C-COKE-\d+; free_garlic_sauce:C-GARL-\d+/);
    expect(col(optin, "first_src")).toBe("test-src");
    expect(col(optin, "utm_campaign")).toBe("test");
    expect(col(optin, "nickname")).toBe("Opt In");
    const optout = all.find((r) => col(r, "email") === "optout@example.com")!;
    expect(col(optout, "marketing_status")).toBe("none");

    const only = parseCsv(await claimersCsv(db, true));
    expect(only).toHaveLength(2);
    expect(col(only[1], "email")).toBe("optin@example.com");
  });

  it("shows a withdrawal as the current marketing status", async () => {
    const { playerId } = await claimPlayer("leaver@example.com", { optIn: true });
    const { unsubscribe } = await import("../unsubscribe");
    const { signToken } = await import("../tokens");
    await unsubscribe(db, signToken("unsubscribe", { v: 1, p: playerId }), {
      ip: "198.51.100.2",
      userAgent: "mail-client",
      now: new Date(),
    });
    const csv = parseCsv(await claimersCsv(db, false));
    const row = csv[1];
    const col = (name: string) => row[csv[0].indexOf(name)];
    expect(col("marketing_opt_in")).toBe("no");
    expect(col("marketing_status")).toBe("withdrawn");
    expect(col("marketing_source")).toBe("unsubscribe");
    // Opted-in only leaves them out.
    expect(parseCsv(await claimersCsv(db, true))).toHaveLength(1);
  });

  it("defuses spreadsheet formulas in nicknames", async () => {
    // A nickname can't start with = (format rules), but a placement can carry odd text.
    await claimPlayer("formula@example.com");
    await db
      .update(players)
      .set({ nickname: "=SUM(A1)", firstSrc: "@cmd" })
      .where(eq(players.emailNormalized, "formula@example.com"));
    const csv = await claimersCsv(db, false);
    expect(csv).toContain("'=SUM(A1)");
    expect(csv).toContain("'@cmd");
  });
});

describe("data retention (DATA-06)", () => {
  const DAY = 86_400_000;
  const endCampaign = (daysAgo: number, retentionDays = 90) =>
    db
      .update(campaignSettings)
      .set({ endsAt: new Date(Date.now() - daysAgo * DAY), retentionDays });

  it("does nothing before the purge date or without an end date", async () => {
    await claimPlayer("early@example.com");
    expect(await runRetention(db)).toEqual({ due: false, anonymized: 0, remaining: 0 });
    await endCampaign(30);
    expect(await runRetention(db)).toEqual({ due: false, anonymized: 0, remaining: 0 });
    expect(await searchPlayers(db, "early@")).toHaveLength(1);
  });

  it("anonymizes players who did not opt in once 90 days have passed, and keeps opted-in contacts", async () => {
    const out = await claimPlayer("out@example.com");
    const inn = await claimPlayer("in@example.com", { optIn: true });
    await endCampaign(120);
    // Their codes expired along with the campaign.
    await db.execute(sql`update claims set expires_at = now() - interval '30 days'`);
    expect(await retentionDue(db)).toBe(1);
    const res = await runRetention(db);
    expect(res).toEqual({ due: true, anonymized: 1, remaining: 0 });
    const [gone] = await db.select().from(players).where(eq(players.id, out.playerId));
    expect(gone.deletedAt).not.toBeNull();
    expect(gone.email).toContain("@erased.invalid");
    const [kept] = await db.select().from(players).where(eq(players.id, inn.playerId));
    expect(kept.deletedAt).toBeNull();
    expect(kept.email).toBe("in@example.com");
    const log = await db.select().from(adminAudit);
    expect(log.map((r) => r.action)).toContain("retention.purge");
    expect(log[0].adminEmail).toBe("system:retention");
    expect(await runRetention(db)).toMatchObject({ anonymized: 0 });
  });

  it("honours a longer retention setting and waits for unexpired codes", async () => {
    const holder = await claimPlayer("holder@example.com");
    await endCampaign(100, 180);
    expect((await runRetention(db)).due).toBe(false);
    await endCampaign(200, 180);
    // Still holds codes that haven't expired.
    expect(await runRetention(db)).toMatchObject({ due: true, anonymized: 0 });
    await db.execute(sql`update claims set expires_at = now() - interval '1 day'`);
    expect(await runRetention(db)).toMatchObject({ anonymized: 1 });
    const [p] = await db.select().from(players).where(eq(players.id, holder.playerId));
    expect(p.deletedAt).not.toBeNull();
  });

  it("works through a backlog in batches", async () => {
    for (let i = 0; i < 5; i++) await claimPlayer(`p${i}@example.com`);
    await endCampaign(200);
    await db.execute(sql`update claims set expires_at = now() - interval '1 day'`);
    expect(await runRetention(db, new Date(), 2)).toEqual({
      due: true,
      anonymized: 2,
      remaining: 3,
    });
    expect(await runRetention(db, new Date(), 10)).toEqual({
      due: true,
      anonymized: 3,
      remaining: 0,
    });
  });
});
