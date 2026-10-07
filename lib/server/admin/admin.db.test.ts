import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { newEvent, newPlayer, newRun, type EventDoc } from "@/db/schema";
import { TUNING, createLevel, distanceMAt } from "@/game-core";
import { parseCsv } from "@/lib/csv";
import {
  GOOD,
  SHORT,
  addRanked,
  connect,
  finish,
  pointsFor,
  resetDb,
  save,
  seedCampaign,
  type HonestRun,
} from "@/tests/db";
import { montrealDay, recordServerEvent, rollupEvents } from "../analytics";
import { consentText } from "../consent";
import { rankOfPlayer, topEntries } from "../leaderboard";
import { FUNNEL_STEPS, emptyFunnel, funnel, health, sumFunnel } from "./dashboard";
import { PLAYER_COLUMNS, playersCsv, type PlayersCsvOptions } from "./export";
import { boardForModeration, flagSummary, flaggedRuns, winnerIds, winners } from "./moderation";
import {
  erasePlayer,
  exportPlayer,
  playerDetail,
  renamePlayer,
  searchPlayers,
  setHidden,
} from "./players";
import { RETENTION_ACTOR, purgeDate, retentionDue, runRetention } from "./retention";
import { loadSettings, saveSettings, toForm, validateSettings } from "./settings";

const { db, close } = connect();
afterAll(close);
beforeEach(async () => {
  await resetDb(db);
  await seedCampaign(db);
});

const NOBODY = "00000000-0000-4000-8000-000000000000";
const DAY = 86_400_000;

let seed = 100;
/** A player who played a run and saved it with this email, through the real services. */
async function savedPlayer(
  email: string,
  extra: { nickname?: string; marketingOptIn?: boolean; lang?: "fr" | "en" } = {},
  run: HonestRun = GOOD(seed++),
) {
  const finished = await finish(db, run);
  const saved = await save(db, finished, email, extra);
  return { ...saved, run, runId: finished.runId };
}

describe("campaign settings (ADM-07)", () => {
  it("loads what is stored, as the form shows it", async () => {
    const settings = await loadSettings(db);
    expect(settings).toMatchObject({ leaderboardOpen: true, retentionDays: 90 });
    const form = toForm(settings);
    expect(form).toMatchObject({ leaderboardOpen: true, retentionDays: "90" });
    expect(form.startsAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(validateSettings(form).ok).toBe(true);
  });

  it("validates the dates and the retention period", () => {
    const blank = { startsAt: "", endsAt: "", leaderboardOpen: false, retentionDays: "90" };
    expect(validateSettings(blank)).toEqual({
      ok: true,
      value: { startsAt: null, endsAt: null, leaderboardOpen: false, retentionDays: 90 },
    });
    const bad = validateSettings({
      startsAt: "2026-11-01T00:00",
      endsAt: "2026-10-01T00:00",
      leaderboardOpen: true,
      retentionDays: "0",
    });
    expect(bad).toEqual({
      ok: false,
      errors: [
        "The end must be after the start.",
        "Retention is a whole number of days, 1 to 3650.",
      ],
    });
    const same = { startsAt: "2026-10-15T00:00", endsAt: "2026-10-15T00:00" };
    expect(validateSettings({ ...blank, ...same }).ok).toBe(false);
    expect(validateSettings({ ...blank, startsAt: "2026-02-30T10:00" }).ok).toBe(false);
    expect(validateSettings({ ...blank, endsAt: "soon" }).ok).toBe(false);
    for (const days of ["3651", "12.5", "-3", ""]) {
      expect(validateSettings({ ...blank, retentionDays: days }).ok).toBe(false);
    }
    for (const days of ["1", "3650"]) {
      expect(validateSettings({ ...blank, retentionDays: days }).ok).toBe(true);
    }
  });

  it("saves only what changed, with before and after in the audit log", async () => {
    const form = toForm(await loadSettings(db));
    const next = validateSettings({
      ...form,
      startsAt: "2026-10-15T00:00",
      endsAt: "2026-11-15T23:59",
      leaderboardOpen: false,
      retentionDays: "120",
    });
    if (!next.ok) throw new Error(next.errors.join());
    const changed = await saveSettings(db, "admin@example.com", next.value);
    expect(changed.sort()).toEqual(["endsAt", "leaderboardOpen", "retentionDays", "startsAt"]);
    expect(await loadSettings(db)).toEqual({
      startsAt: new Date("2026-10-15T04:00:00.000Z"),
      endsAt: new Date("2026-11-16T04:59:00.000Z"),
      leaderboardOpen: false,
      retentionDays: 120,
    });
    expect((await db.campaignSettings.findOne({ _id: 1 }))?.updatedBy).toBe("admin@example.com");

    const log = await db.adminAudit.find().sort({ _id: 1 }).toArray();
    expect(log.map((r) => [r.action, r.target])).toEqual([
      ["campaign.dates", "startsAt"],
      ["campaign.dates", "endsAt"],
      ["campaign.leaderboard", "leaderboardOpen"],
      ["campaign.policy", "retentionDays"],
    ]);
    expect(log.every((r) => r.adminEmail === "admin@example.com")).toBe(true);
    expect(log[2].details).toEqual({ field: "leaderboardOpen", from: true, to: false });
    expect(log[3].details).toEqual({ field: "retentionDays", from: 90, to: 120 });

    // The same values again: nothing written, nothing logged.
    expect(await saveSettings(db, "admin@example.com", next.value)).toEqual([]);
    expect(await db.adminAudit.countDocuments()).toBe(4);
  });

  it("switching the leaderboard off stops new scores at once", async () => {
    const before = await finish(db, GOOD(1));
    expect(before.saveToken).not.toBeNull();
    const form = toForm(await loadSettings(db));
    const off = validateSettings({ ...form, leaderboardOpen: false });
    if (!off.ok) throw new Error(off.errors.join());
    expect(await saveSettings(db, "admin@example.com", off.value)).toEqual(["leaderboardOpen"]);
    // Saving cleared the campaign cache, so the very next run already sees the switch.
    expect(await finish(db, GOOD(2))).toMatchObject({
      valid: true,
      saveToken: null,
      rankPreview: null,
    });
    // A run from before the switch can't be saved any more either.
    await expect(save(db, before, "late@example.com")).rejects.toThrow("closed");
  });
});

describe("the board as admins see it (LB-07)", () => {
  it("ranks by points, then whoever got there first; hidden entries are listed but unranked", async () => {
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    await addRanked(db, { email: "low@example.com", nickname: "Low", points: 90 });
    await addRanked(db, {
      email: "late@example.com",
      nickname: "Late",
      points: 300,
      achievedAt: ago(5),
    });
    await addRanked(db, {
      email: "early@example.com",
      nickname: "Early",
      points: 300,
      achievedAt: ago(30),
    });
    await addRanked(db, { email: "hid@example.com", nickname: "Hid", points: 500, hidden: true });
    await addRanked(db, { email: "top@example.com", nickname: "Top", points: 400, garlic: 10 });

    const board = await boardForModeration(db);
    expect(board.map((e) => [e.nickname, e.rank, e.points])).toEqual([
      ["Hid", null, 500],
      ["Top", 1, 400],
      ["Early", 2, 300],
      ["Late", 3, 300],
      ["Low", 4, 90],
    ]);
    expect(board[0].hidden).toBe(true);
    expect(board[1]).toMatchObject({
      email: "top@example.com",
      hidden: false,
      distanceM: 300,
      garlic: 10,
    });
    // The public board agrees on the order.
    expect((await topEntries(db, 10)).map((e) => e.name)).toEqual(["Top", "Early", "Late", "Low"]);
    expect(await boardForModeration(db, 2)).toHaveLength(2);
  });

  it("lists flagged runs and counts them by reason", async () => {
    await finish(db, { ...GOOD(5), garlic: 999 });
    await finish(db, { ...SHORT(6), distance: 5000 });
    await finish(db, GOOD(7)); // valid: not listed
    const flagged = await flaggedRuns(db);
    expect(flagged.map((r) => r.reason).sort()).toEqual(["distance", "garlic"]);
    expect(flagged.find((r) => r.reason === "distance")).toMatchObject({
      distanceM: 5000,
      playerId: null,
      src: "test-src",
      clientVersion: "test",
    });
    expect(await flagSummary(db)).toEqual([
      { reason: "distance", n: 1 },
      { reason: "garlic", n: 1 },
    ]);
  });
});

describe("winners", () => {
  it("are the top 3 visible players, with what Boustan needs to reach them", async () => {
    for (const [i, points] of [500, 400, 300, 200, 100].entries()) {
      await addRanked(db, {
        email: `p${i}@example.com`,
        nickname: `P${i}`,
        points,
        language: i === 2 ? "fr" : "en",
        marketingOptIn: i === 2,
      });
    }
    const second = (await db.players.findOne({ email: "p1@example.com" }))!;
    await setHidden(db, second._id, true);

    const top = await winners(db);
    expect(top.map((w) => [w.rank, w.nickname, w.email, w.points])).toEqual([
      [1, "P0", "p0@example.com", 500],
      [2, "P2", "p2@example.com", 300],
      [3, "P3", "p3@example.com", 200],
    ]);
    expect(top[1]).toMatchObject({ language: "fr", marketingOptIn: true });
    // These scores were placed directly, so there is no run to check them against.
    expect(top[0]).toMatchObject({ activeMs: null, hits: null, garlicAppeared: null });
    expect(await winnerIds(db)).toEqual(top.map((w) => w.playerId));
    expect((await topEntries(db, 3)).map((e) => e.name)).toEqual(["P0", "P2", "P3"]);
  });

  it("carry the numbers of the run behind the score", async () => {
    const run = GOOD(21);
    const finished = await finish(db, run);
    const { playerId } = await save(db, finished, "Winner@Example.com", {
      nickname: "Top Dog",
      marketingOptIn: true,
      lang: "fr",
    });
    const [w] = await winners(db);
    expect(w).toMatchObject({
      playerId,
      rank: 1,
      nickname: "Top Dog",
      email: "Winner@Example.com",
      language: "fr",
      marketingOptIn: true,
      runId: finished.runId,
      points: pointsFor(run),
      garlic: run.garlic,
      activeMs: run.activeMs,
      hits: run.hits,
      garlicAppeared: createLevel(run.seed).garlicSpawnedUpTo(distanceMAt(run.activeMs)),
    });
    expect(w.garlicAppeared).toBeGreaterThanOrEqual(w.garlic);
  });

  it("are nobody while the board is empty", async () => {
    expect(await winners(db)).toEqual([]);
    expect(await winnerIds(db)).toEqual([]);
  });
});

describe("players export (ADM-06, CRM-02)", () => {
  /** The CSV as one object per row, keyed by column. */
  async function read(opts?: PlayersCsvOptions) {
    const [head, ...rows] = parseCsv(await playersCsv(db, opts));
    expect(head).toEqual(PLAYER_COLUMNS);
    return rows.map((r) => Object.fromEntries(head.map((name, i) => [name, r[i]])));
  }

  it("has a row per player on the board, in rank order, with the score and consent fields", async () => {
    const opted = await savedPlayer("optin@example.com", {
      nickname: "Opt In",
      marketingOptIn: true,
    });
    await addRanked(db, { email: "top@example.com", nickname: "Top", points: 99_999 });
    await addRanked(db, {
      email: "hid@example.com",
      nickname: "Hid",
      points: 50_000,
      hidden: true,
    });
    await addRanked(db, { email: "last@example.com", nickname: "Last", points: 1 });

    const rows = await read();
    expect(rows.map((r) => [r.rank, r.email, r.hidden])).toEqual([
      ["1", "top@example.com", "no"],
      ["", "hid@example.com", "yes"],
      ["2", "optin@example.com", "no"],
      ["3", "last@example.com", "no"],
    ]);
    const terms = consentText("en", "terms_age");
    const marketing = consentText("en", "marketing");
    expect(rows[2]).toMatchObject({
      nickname: "Opt In",
      points: String(pointsFor(opted.run)),
      distance_m: String(Math.floor(distanceMAt(opted.run.activeMs))),
      garlic: String(opted.run.garlic),
      language: "en",
      marketing_opt_in: "yes",
      terms_age_text: terms.text,
      terms_age_text_version: terms.version,
      marketing_status: "granted",
      marketing_text: marketing.text,
      marketing_text_version: marketing.version,
      marketing_language: "en",
      marketing_source: "save_form",
      marketing_ip: "203.0.113.7",
      marketing_user_agent: "vitest",
      marketing_host_origin: "https://host.example",
      first_src: "test-src",
      utm_campaign: "test",
      first_host: "https://host.example",
    });
    expect(rows[2].terms_age_accepted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(rows[2].achieved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(rows[0]).toMatchObject({
      points: "99999",
      marketing_opt_in: "no",
      marketing_status: "none",
      terms_age_accepted_at: "",
    });
  });

  it("can be limited to the winners or to players who opted in, keeping the board's ranks", async () => {
    await addRanked(db, { email: "a@example.com", points: 500, marketingOptIn: true });
    await addRanked(db, {
      email: "b@example.com",
      points: 400,
      hidden: true,
      marketingOptIn: true,
    });
    await addRanked(db, { email: "c@example.com", points: 300 });
    await addRanked(db, { email: "d@example.com", points: 200, marketingOptIn: true });
    await addRanked(db, { email: "e@example.com", points: 100, marketingOptIn: true });

    const ranks = (rows: Record<string, string>[]) => rows.map((r) => [r.rank, r.email]);
    expect(ranks(await read({ winnersOnly: true }))).toEqual([
      ["1", "a@example.com"],
      ["2", "c@example.com"],
      ["3", "d@example.com"],
    ]);
    expect(ranks(await read({ optedInOnly: true }))).toEqual([
      ["1", "a@example.com"],
      ["", "b@example.com"],
      ["3", "d@example.com"],
      ["4", "e@example.com"],
    ]);
    expect(ranks(await read({ winnersOnly: true, optedInOnly: true }))).toEqual([
      ["1", "a@example.com"],
      ["3", "d@example.com"],
    ]);
  });

  it("leaves out erased players and players without a score", async () => {
    const gone = await savedPlayer("gone@example.com");
    await erasePlayer(db, gone.playerId);
    await db.players.insertOne(
      newPlayer({ email: "none@example.com", emailNormalized: "none@example.com", language: "en" }),
    );
    expect(await read()).toEqual([]);
  });

  it("quotes commas and quotes, and defuses spreadsheet formulas", async () => {
    await addRanked(db, {
      email: "formula@example.com",
      nickname: '=HYPERLINK("x")',
      points: 10,
      firstSrc: "@cmd",
      utm: { utm_campaign: 'fall, "launch"' },
    });
    const csv = await playersCsv(db);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    const [row] = await read();
    expect(row).toMatchObject({
      nickname: `'=HYPERLINK("x")`,
      first_src: "'@cmd",
      utm_campaign: 'fall, "launch"',
    });
  });
});

describe("players (ADM-04)", () => {
  it("searches by email or nickname, literally, and shows each player's best points", async () => {
    const marie = await savedPlayer("marie.tremblay@example.com", { nickname: "Marie T" });
    await savedPlayer("omar@example.com", { nickname: "Omar 100" });
    expect((await searchPlayers(db, "tremblay")).map((p) => p.nickname)).toEqual(["Marie T"]);
    expect((await searchPlayers(db, "OMAR")).map((p) => p.email)).toEqual(["omar@example.com"]);
    expect((await searchPlayers(db, "100")).map((p) => p.nickname)).toEqual(["Omar 100"]);
    expect(await searchPlayers(db, "%")).toHaveLength(0); // % is not a wildcard
    expect(await searchPlayers(db, ".*")).toHaveLength(0); // nor is a regex
    expect(await searchPlayers(db, "(")).toHaveLength(0); // and a bracket is just a character
    expect(await searchPlayers(db, "")).toHaveLength(2);
    expect((await searchPlayers(db, "marie"))[0]).toMatchObject({
      id: marie.playerId,
      language: "en",
      hidden: false,
      marketingOptIn: false,
      bestPoints: pointsFor(marie.run),
    });

    await db.players.insertOne(
      newPlayer({
        email: "nobest@example.com",
        emailNormalized: "nobest@example.com",
        language: "fr",
      }),
    );
    expect((await searchPlayers(db, "nobest"))[0].bestPoints).toBeNull();
  });

  it("shows one player's runs, consents and devices", async () => {
    const p = await savedPlayer("full@example.com", { nickname: "Full", marketingOptIn: true });
    // A later run from the same device is saved as it finishes.
    await finish(db, SHORT(5), p.response.playerToken);
    const detail = (await playerDetail(db, p.playerId))!;
    expect(Object.keys(detail).sort()).toEqual(["best", "consents", "devices", "player", "runs"]);
    expect(detail.player.email).toBe("full@example.com");
    expect(detail.runs).toHaveLength(2);
    expect(detail.runs.every((r) => r.savedAt !== null && r.playerId === p.playerId)).toBe(true);
    expect(detail.best).toMatchObject({ runId: p.runId, points: pointsFor(p.run) });
    expect(detail.consents.map((c) => c.kind).sort()).toEqual(["marketing", "terms_age"]);
    expect(detail.devices).toBe(1);
    expect(await playerDetail(db, NOBODY)).toBeNull();
  });

  it("exports everything held about a player as JSON", async () => {
    const p = await savedPlayer("export@example.com", { nickname: "Exporter" });
    const data = (await exportPlayer(db, p.playerId))!;
    expect(Object.keys(data).sort()).toEqual([
      "bestRun",
      "consents",
      "exportedAt",
      "player",
      "runs",
    ]);
    expect(data.player).toMatchObject({
      id: p.playerId,
      email: "export@example.com",
      nickname: "Exporter",
      hiddenFromLeaderboard: false,
      marketingOptIn: false,
      firstSrc: "test-src",
    });
    expect(data.player).not.toHaveProperty("emailBlockedAt");
    expect(data.bestRun).toEqual({
      points: pointsFor(p.run),
      distanceM: distanceMAt(p.run.activeMs),
      garlic: p.run.garlic,
      achievedAt: expect.any(Date),
      runId: p.runId,
    });
    expect(data.runs).toEqual([
      expect.objectContaining({ id: p.runId, status: "valid", points: pointsFor(p.run) }),
    ]);
    expect(data.consents.map((c) => c.kind)).toEqual(["terms_age"]);
    const json = JSON.stringify(data);
    expect(json).not.toContain("tokenHash");
    expect(json).not.toContain('"_id"');
    expect(await exportPlayer(db, NOBODY)).toBeNull();
  });
});

describe("erasing a player (DATA-07)", () => {
  it("removes personal data, consents, devices and the leaderboard row, and keeps anonymous totals", async () => {
    const gone = await savedPlayer("gone@example.com", { nickname: "Goner", marketingOptIn: true });
    const other = await savedPlayer("stays@example.com", { nickname: "Stayer" });
    expect(await topEntries(db, 10)).toHaveLength(2);

    expect(await erasePlayer(db, gone.playerId)).toEqual({ consentRows: 2, devices: 1 });

    const p = (await db.players.findOne({ _id: gone.playerId }))!;
    expect(p.email).toBe(`erased-${gone.playerId}@erased.invalid`);
    expect(p).toMatchObject({
      nickname: null,
      marketingOptIn: false,
      hidden: false,
      ageConfirmedAt: null,
      utm: {},
      crmStatus: "skipped",
    });
    expect(p.deletedAt).not.toBeNull();
    expect(await db.consents.countDocuments({ playerId: gone.playerId })).toBe(0);
    expect(await db.playerTokens.countDocuments({ playerId: gone.playerId })).toBe(0);
    expect(await db.bestRuns.countDocuments({ _id: gone.playerId })).toBe(0);
    expect((await topEntries(db, 10)).map((e) => e.name)).toEqual(["Stayer"]);
    // Anonymous totals: the run is still counted.
    expect(await db.runs.countDocuments({ playerId: gone.playerId })).toBe(1);
    // The other player is untouched.
    expect(await db.consents.countDocuments({ playerId: other.playerId })).toBe(1);
    // Erasing twice does nothing, and the player is gone from the lists.
    expect(await erasePlayer(db, gone.playerId)).toBeNull();
    expect(await searchPlayers(db, "")).toHaveLength(1);
  });

  it("skips the player's queued CRM rows", async () => {
    const p = await savedPlayer("crm@example.com", { marketingOptIn: true });
    const queued = await db.crmOutbox.find({ playerId: p.playerId }).toArray();
    expect(queued.length).toBeGreaterThan(0);
    expect(queued.every((r) => r.status === "pending")).toBe(true);
    await erasePlayer(db, p.playerId);
    const rows = await db.crmOutbox.find({ playerId: p.playerId }).toArray();
    expect(rows).toHaveLength(queued.length);
    expect(rows.every((r) => r.status === "skipped" && r.lastError === "player erased")).toBe(true);
  });

  it("lifts the block on a hidden player: the address can come back as a new player", async () => {
    const troll = await savedPlayer("troll@example.com", { nickname: "Troll" });
    await setHidden(db, troll.playerId, true);
    // While hidden, a new score with the same email stays with the hidden player.
    const again = await savedPlayer("troll+again@example.com");
    expect(again.playerId).toBe(troll.playerId);
    expect(await topEntries(db, 10)).toEqual([]);

    await erasePlayer(db, troll.playerId);
    expect((await db.players.findOne({ _id: troll.playerId }))!.hidden).toBe(false);
    const back = await savedPlayer("troll@example.com", { nickname: "Reformed" });
    expect(back.playerId).not.toBe(troll.playerId);
    expect((await topEntries(db, 10)).map((e) => e.name)).toEqual(["Reformed"]);
  });
});

describe("hiding and renaming (LB-07)", () => {
  it("hides and shows an entry, and renames it within the format rules", async () => {
    const { player } = await addRanked(db, {
      email: "x@example.com",
      nickname: "Troll",
      points: 200,
    });
    await addRanked(db, { email: "nice@example.com", nickname: "Nice", points: 100 });

    expect(await renamePlayer(db, player._id, "  Better   Name ")).toBe("Better Name");
    for (const bad of ["<script>", "x", "A name far too long for it"]) {
      expect(await renamePlayer(db, player._id, bad)).toBeNull();
    }
    expect((await topEntries(db, 10)).map((e) => e.name)).toEqual(["Better Name", "Nice"]);

    expect(await setHidden(db, player._id, true)).toBe(true);
    expect((await topEntries(db, 10)).map((e) => e.name)).toEqual(["Nice"]);
    expect(await rankOfPlayer(db, player._id)).toBeNull();
    expect(await setHidden(db, player._id, false)).toBe(true);
    expect((await topEntries(db, 10)).map((e) => e.name)).toEqual(["Better Name", "Nice"]);
  });

  it("gives a new food name for a blank one", async () => {
    const { player } = await addRanked(db, {
      email: "blank@example.com",
      nickname: "Old",
      points: 1,
    });
    const name = await renamePlayer(db, player._id, "  ");
    expect(name).toMatch(/^\S+ \S+ \d+$/);
    expect((await db.players.findOne({ _id: player._id }))!.nickname).toBe(name);
  });

  it("can't hide or rename a player who isn't there, or was erased", async () => {
    expect(await setHidden(db, NOBODY, true)).toBe(false);
    expect(await renamePlayer(db, NOBODY, "Nobody")).toBeNull();
    const { player } = await addRanked(db, { email: "erased@example.com", points: 5 });
    await erasePlayer(db, player._id);
    expect(await setHidden(db, player._id, true)).toBe(false);
    expect(await renamePlayer(db, player._id, "Ghost")).toBeNull();
  });
});

describe("data retention (DATA-06)", () => {
  const endContest = (daysAgo: number | null, retentionDays = 90) =>
    db.campaignSettings.updateOne(
      { _id: 1 },
      {
        $set: {
          endsAt: daysAgo === null ? null : new Date(Date.now() - daysAgo * DAY),
          retentionDays,
        },
      },
    );
  /** Three players far ahead of everyone else: the winners. */
  const addWinners = async () => {
    for (let i = 0; i < 3; i++) {
      await addRanked(db, { email: `winner${i}@example.com`, points: 10_000 - i });
    }
  };

  it("starts the purge the retention period after the end date", async () => {
    await endContest(null);
    expect(await purgeDate(db)).toBeNull();
    await endContest(10, 30);
    const endsAt = (await db.campaignSettings.findOne({ _id: 1 }))!.endsAt!;
    expect((await purgeDate(db))!.getTime()).toBe(endsAt.getTime() + 30 * DAY);
  });

  it("does nothing before the purge date or without an end date", async () => {
    await addWinners();
    await addRanked(db, { email: "early@example.com", points: 1 });
    await endContest(null);
    expect(await retentionDue(db)).toBe(0);
    expect(await runRetention(db)).toEqual({ due: false, anonymized: 0, remaining: 0 });
    await endContest(100, 180);
    expect(await runRetention(db)).toEqual({ due: false, anonymized: 0, remaining: 0 });
    expect(await searchPlayers(db, "early@")).toHaveLength(1);
    await endContest(200, 180);
    expect(await retentionDue(db)).toBe(1);
    expect(await runRetention(db)).toEqual({ due: true, anonymized: 1, remaining: 0 });
    expect(await searchPlayers(db, "early@")).toEqual([]);
  });

  it("anonymizes players who did not opt in, and keeps opted-in contacts and the current winners", async () => {
    await addRanked(db, { email: "first@example.com", points: 500 });
    await addRanked(db, { email: "second@example.com", points: 400 });
    await addRanked(db, { email: "hidden@example.com", points: 450, hidden: true });
    await addRanked(db, { email: "third@example.com", points: 300 });
    await addRanked(db, { email: "in@example.com", points: 200, marketingOptIn: true });
    const out = await addRanked(db, { email: "out@example.com", points: 100 });
    await endContest(120);

    // The hidden player isn't a winner; the opted-in one is kept anyway.
    expect(await retentionDue(db)).toBe(2);
    expect(await runRetention(db)).toEqual({ due: true, anonymized: 2, remaining: 0 });
    const kept = await db.players.find({ deletedAt: null }).toArray();
    expect(kept.map((p) => p.email).sort()).toEqual([
      "first@example.com",
      "in@example.com",
      "second@example.com",
      "third@example.com",
    ]);
    expect((await db.players.findOne({ _id: out.player._id }))!.email).toContain("@erased.invalid");
    expect((await winners(db)).map((w) => w.email)).toEqual([
      "first@example.com",
      "second@example.com",
      "third@example.com",
    ]);

    const log = await db.adminAudit.find().toArray();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      adminEmail: RETENTION_ACTOR,
      action: "retention.purge",
      target: "players",
      details: { anonymized: 2 },
    });
    // Nothing left to do: nothing more is logged.
    expect(await runRetention(db)).toEqual({ due: true, anonymized: 0, remaining: 0 });
    expect(await db.adminAudit.countDocuments()).toBe(1);
  });

  it("works through a backlog in batches, oldest players first", async () => {
    await addWinners();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { player } = await addRanked(db, {
        email: `p${i}@example.com`,
        points: 10 + i,
        createdAt: new Date(Date.now() - (50 - i) * 60_000),
      });
      ids.push(player._id);
    }
    await endContest(200);
    expect(await runRetention(db, new Date(), 2)).toEqual({
      due: true,
      anonymized: 2,
      remaining: 3,
    });
    const erased = await db.players.find({ deletedAt: { $ne: null } }).toArray();
    expect(erased.map((p) => p._id).sort()).toEqual([ids[0], ids[1]].sort());
    expect(await runRetention(db, new Date(), 10)).toEqual({
      due: true,
      anonymized: 3,
      remaining: 0,
    });
    expect(await db.players.countDocuments({ deletedAt: null })).toBe(3);
  });
});

describe("dashboard (ADM-02)", () => {
  const ev = (name: string, sessionId: string, extra: Partial<EventDoc> = {}) =>
    newEvent({ name, sessionId, src: "lapresse", lang: "fr", device: "mobile", ...extra });
  const elsewhere = { src: "other", lang: "en", device: "desktop" };

  it("counts the funnel steps from the rolled-up events", async () => {
    await db.events.insertMany([
      ev("load", "s1"),
      ev("load", "s1"),
      ev("load", "s2"),
      ev("start", "s1"),
      ev("start", "s1"),
      ev("start", "s2"),
      ev("game_over", "s1"),
      ev("game_over", "s1"),
      ev("game_over", "s2"),
      ev("milestone", "s1", { props: { points: 100 } }),
      ev("save_view", "s1"),
      ev("save_success", "s1"),
      ev("save_error", "s2", { props: { reason: "closed" } }),
      ev("load", "s3", elsewhere),
      ev("start", "s3", elsewhere),
    ]);
    await recordServerEvent(db, "opt_in", {}, { src: "lapresse", lang: "fr", device: "mobile" });
    const today = montrealDay();
    await rollupEvents(db, today);

    const bySrc = await funnel(db, today, today, "src");
    expect(bySrc).toEqual([
      { key: "lapresse", loads: 2, starts: 3, finishes: 3, saveViews: 1, saves: 1, optIns: 1 },
      { key: "other", loads: 1, starts: 1, finishes: 0, saveViews: 0, saves: 0, optIns: 0 },
    ]);
    const total = { loads: 3, starts: 4, finishes: 3, saveViews: 1, saves: 1, optIns: 1 };
    expect(await funnel(db, today, today, "day")).toEqual([{ key: today, ...total }]);
    expect(sumFunnel(bySrc)).toEqual(total);
    expect(sumFunnel([])).toEqual(emptyFunnel());
    expect(FUNNEL_STEPS.map((s) => s.key)).toEqual(Object.keys(emptyFunnel()));
    expect(await funnel(db, "2000-01-01", "2000-01-02", "day")).toEqual([]);
  });

  it("reports players, runs, flags, scores saved today and the top score", async () => {
    expect(await health(db)).toEqual({
      players: 0,
      optedIn: 0,
      runs24h: 0,
      flaggedRuns24h: 0,
      savedToday: 0,
      top: null,
    });

    const alpha = await savedPlayer("alpha@example.com", {
      nickname: "Alpha",
      marketingOptIn: true,
    });
    await finish(db, SHORT(3), alpha.response.playerToken); // saved as it finishes
    await finish(db, SHORT(4)); // anonymous: not saved
    await finish(db, { ...GOOD(5), garlic: 999 }); // flagged
    // A hidden player's score is not the top score.
    await addRanked(db, {
      email: "hid@example.com",
      nickname: "Hid",
      points: 1_000_000,
      hidden: true,
    });
    // A run saved two days ago counts for neither the last 24 hours nor today.
    const old = new Date(Date.now() - 2 * DAY);
    await db.runs.insertOne(
      newRun({
        _id: randomUUID(),
        seed: 1,
        tuningVersion: TUNING.version,
        issuedAt: old,
        finishedAt: old,
        activeMs: 1000,
        distanceM: 4,
        garlic: 0,
        hits: 0,
        points: 4,
        status: "valid",
        savedAt: old,
      }),
    );

    expect(await health(db)).toEqual({
      players: 2,
      optedIn: 1,
      runs24h: 4,
      flaggedRuns24h: 1,
      savedToday: 2,
      top: { points: pointsFor(alpha.run), nickname: "Alpha" },
    });
  });
});
