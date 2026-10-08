import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { TUNING, distanceMAt } from "@/game-core";
import { cleanNickname } from "@/lib/nicknames";
import {
  GOOD,
  SHORT,
  addRanked,
  connect,
  ctx,
  finish,
  honestRun,
  pointsFor,
  resetDb,
  save,
  seedCampaign,
} from "@/tests/db";
import { consentText } from "./consent";
import { topEntries } from "./leaderboard";
import { findPlayerByToken, issuePlayerToken } from "./players";
import { SAVE_WINDOW_MS, finishRun } from "./runs";
import { saveScore, type SaveInput, type SaveSuccess } from "./scores";
import { signToken } from "./tokens";

const { db, close } = connect(40);
afterAll(close);
beforeEach(async () => {
  await resetDb(db);
  await seedCampaign(db);
});

const form = (
  saveToken: string | null,
  email: string,
  extra: Partial<SaveInput> = {},
): SaveInput => ({
  saveToken: saveToken!,
  email,
  lang: "en",
  termsAge: true,
  marketingOptIn: false,
  src: "form-src",
  utm: {},
  ...extra,
});

/** One save attempt through the service, success or not. */
const attempt = (
  saveToken: string | null,
  email: string,
  extra: Partial<SaveInput> = {},
  now = new Date(),
) => saveScore(db, form(saveToken, email, extra), { ...ctx(), now });

/** A save token as finish would sign it, for a run the test picks. */
const saveTokenFor = (runId: string, exp = Date.now() + 60_000) =>
  signToken("save", { v: 1, run: runId, exp });

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

/** How much each table holds: what a refused save must leave exactly as it was. */
async function written() {
  return {
    players: await db.players.countDocuments(),
    tokens: await db.playerTokens.countDocuments(),
    consents: await db.consents.countDocuments(),
    best: await db.bestRuns.countDocuments(),
    crm: await db.crmOutbox.countDocuments(),
  };
}
const EMPTY = { players: 0, tokens: 0, consents: 0, best: 0, crm: 0 };

describe("POST /api/score: a new player (SEC-04, DATA-01 to DATA-03, CRM-05)", () => {
  it("creates the player, a device token, the consent, the best run and the CRM row in one go", async () => {
    const run = GOOD();
    const finished = await finish(db, run);
    const res = await save(db, finished, " Alex.Tremblay+jeu@Gmail.com ", {
      nickname: "Toum Fan",
      src: "form-src",
    });

    expect(res.response).toEqual({
      playerToken: expect.stringMatching(/^[\w-]{43}$/),
      rank: 1,
      best: {
        points: pointsFor(run),
        distanceM: distanceMAt(run.activeMs),
        garlic: run.garlic,
      },
    });
    expect(res.optedIn).toBe(false);

    // The address is kept as typed, trimmed; the normalized one keeps a person to one player.
    const player = (await db.players.findOne())!;
    expect(player).toMatchObject({
      _id: res.playerId,
      email: "Alex.Tremblay+jeu@Gmail.com",
      emailNormalized: "alextremblay@gmail.com",
      nickname: "Toum Fan",
      hidden: false,
      language: "en",
      marketingOptIn: false,
      // Where the run came from wins over what the form says.
      firstSrc: "test-src",
      firstHost: "https://host.example",
      utm: { utm_campaign: "test" },
      deletedAt: null,
    });
    expect(player.ageConfirmedAt).toBeInstanceOf(Date);

    // The device token finds the player later.
    expect(await findPlayerByToken(db, res.response.playerToken)).toMatchObject({
      _id: player._id,
    });

    // The run is spent and credited, and is the best run.
    const row = (await db.runs.findOne({ _id: finished.runId }))!;
    expect(row.playerId).toBe(player._id);
    expect(row.savedAt).toBeInstanceOf(Date);
    expect(await db.bestRuns.findOne({ _id: player._id })).toEqual({
      _id: player._id,
      runId: finished.runId,
      points: pointsFor(run),
      distanceM: distanceMAt(run.activeMs),
      garlic: run.garlic,
      achievedAt: row.finishedAt,
    });

    // One consent row, with exactly the text the form shows.
    const { text, version } = consentText("en", "terms_age");
    const consents = await db.consents.find().toArray();
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({
      playerId: player._id,
      kind: "terms_age",
      granted: true,
      text,
      textVersion: version,
      language: "en",
      source: "save_form",
      ip: "203.0.113.7",
      userAgent: "vitest",
      hostOrigin: "https://host.example",
    });

    // One CRM row: a new contact. No opt-in, so no consent change.
    const crm = await db.crmOutbox.find().toArray();
    expect(crm).toHaveLength(1);
    expect(crm[0]).toMatchObject({
      playerId: player._id,
      type: "contact_upsert",
      payload: { created: true },
      status: "pending",
      idempotencyKey: `contact:${player._id}`,
    });
  });

  it("records an opt-in as its own consent row and CRM event", async () => {
    const res = await save(db, await finish(db, GOOD()), "opt@in.ca", {
      marketingOptIn: true,
      lang: "fr",
    });
    expect(res.optedIn).toBe(true);
    expect(await db.players.findOne()).toMatchObject({ marketingOptIn: true, language: "fr" });

    const consents = await db.consents.find().sort({ _id: 1 }).toArray();
    expect(consents.map((c) => [c.kind, c.granted, c.language, c.source])).toEqual([
      ["terms_age", true, "fr", "save_form"],
      ["marketing", true, "fr", "save_form"],
    ]);
    expect(consents[1].text).toBe(consentText("fr", "marketing").text);

    const crm = await db.crmOutbox.find().toArray();
    expect(crm.map((c) => c.type).sort()).toEqual(["consent_changed", "contact_upsert"]);
    expect(crm.find((c) => c.type === "consent_changed")!.payload).toEqual({
      marketing: true,
      source: "save_form",
    });
  });

  it("returns the rank among the players already on the board", async () => {
    const run = GOOD();
    const p = pointsFor(run);
    await addRanked(db, { email: "a@x.ca", nickname: "a", points: p + 100 });
    await addRanked(db, { email: "b@x.ca", nickname: "b", points: p + 1 });
    // Equal points, but they got there first.
    await addRanked(db, { email: "c@x.ca", nickname: "c", points: p, achievedAt: ago(10) });
    await addRanked(db, { email: "d@x.ca", nickname: "d", points: 3 });
    const res = await save(db, await finish(db, run), "new@x.ca", { nickname: "New" });
    expect(res.response.rank).toBe(4);
    expect((await topEntries(db, 10)).map((e) => e.name)).toEqual(["a", "b", "c", "New", "d"]);
  });

  it("puts a short run on the board too: any valid run can be saved", async () => {
    const res = await save(db, await finish(db, honestRun(5, 1)), "tiny@x.ca");
    expect(res.response.best).toMatchObject({ points: pointsFor(honestRun(5, 1)) });
    expect(res.response.rank).toBe(1);
  });

  it("takes the source and campaign tags from the form when the run has none", async () => {
    const run = GOOD();
    const id = randomUUID();
    const token = signToken("run", {
      v: 1,
      id,
      seed: run.seed,
      iat: Date.now() - run.activeMs - 2000,
      tv: TUNING.version,
      lang: "fr",
      src: null,
      host: null,
      utm: {},
    });
    const { response } = await finishRun(
      db,
      id,
      { token, distance: run.distance, garlic: run.garlic, hits: run.hits, activeMs: run.activeMs },
      { playerToken: null, clientVersion: null, now: new Date() },
    );
    await save(db, response, "attr@x.ca", { src: "form-src", utm: { utm_source: "newsletter" } });
    expect(await db.players.findOne()).toMatchObject({
      firstSrc: "form-src",
      firstHost: null,
      utm: { utm_source: "newsletter" },
    });
  });

  it("grants marketing consent once, and an unticked box never withdraws it", async () => {
    const first = await save(db, await finish(db, GOOD(1)), "keep@in.ca", { marketingOptIn: true });
    const unticked = await save(db, await finish(db, GOOD(2)), "keep@in.ca", {
      marketingOptIn: false,
    });
    const again = await save(db, await finish(db, GOOD(3)), "keep@in.ca", { marketingOptIn: true });
    expect([first.optedIn, unticked.optedIn, again.optedIn]).toEqual([true, false, false]);
    expect((await db.players.findOne())!.marketingOptIn).toBe(true);
    expect(await db.consents.countDocuments({ kind: "marketing" })).toBe(1);
    // Each save confirms the terms and age again, which is its own record.
    expect(await db.consents.countDocuments({ kind: "terms_age" })).toBe(3);
    expect(await db.crmOutbox.countDocuments({ type: "consent_changed" })).toBe(1);
    expect(await db.crmOutbox.countDocuments({ type: "contact_upsert" })).toBe(1);
  });
});

describe("POST /api/score: one token, one save (SEC-04, SEC-07)", () => {
  it("answers a retry by the same player with the same result, and writes nothing twice", async () => {
    const finished = await finish(db, GOOD());
    const first = await save(db, finished, "retry@x.ca", { marketingOptIn: true });
    const before = await written();

    const retry = await save(db, finished, "retry@x.ca", { marketingOptIn: true });
    expect(retry.playerId).toBe(first.playerId);
    expect(retry.response.rank).toBe(first.response.rank);
    expect(retry.response.best).toEqual(first.response.best);
    expect(retry.optedIn).toBe(false);

    // Only a new device token: the first answer may have been lost, so the retry gets its own.
    expect(retry.response.playerToken).not.toBe(first.response.playerToken);
    expect(await written()).toEqual({ ...before, tokens: before.tokens + 1 });
    for (const r of [first, retry]) {
      expect(await findPlayerByToken(db, r.response.playerToken)).toMatchObject({
        _id: first.playerId,
      });
    }
  });

  it("refuses another email with a spent token, and the run stays the first player's", async () => {
    const finished = await finish(db, GOOD());
    const owner = await save(db, finished, "owner@x.ca");
    const before = await written();
    expect(await attempt(finished.saveToken, "other@x.ca")).toEqual({
      ok: false,
      error: "expired",
    });
    expect(await db.runs.findOne({ _id: finished.runId })).toMatchObject({
      playerId: owner.playerId,
    });
    // Nothing was credited, consented to or queued for the second address.
    expect(await db.bestRuns.find().toArray()).toHaveLength(1);
    expect(await written()).toMatchObject({ tokens: before.tokens, consents: before.consents });
    expect(await written()).toMatchObject({ best: before.best, crm: before.crm });
  });

  it("never credits one run to two players: a known device's run is already saved", async () => {
    const { player } = await addRanked(db, { email: "known@x.ca", nickname: "Known", points: 10 });
    const token = await issuePlayerToken(db, player._id);
    const finished = await finish(db, GOOD(), token);
    expect((await db.runs.findOne({ _id: finished.runId }))!.savedAt).toBeInstanceOf(Date);

    const before = await written();
    // Finish only signs a save token for an unknown device, so this one is forged for the test.
    expect(await attempt(saveTokenFor(finished.runId), "someone-else@x.ca")).toEqual({
      ok: false,
      error: "expired",
    });
    expect(await db.runs.findOne({ _id: finished.runId })).toMatchObject({ playerId: player._id });
    expect(await written()).toMatchObject({ tokens: before.tokens, consents: before.consents });
    expect(await written()).toMatchObject({ best: before.best, crm: before.crm });
  });

  it("lets only one of 20 simultaneous saves of one token write anything", async () => {
    const run = GOOD();
    const finished = await finish(db, run);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        attempt(finished.saveToken, "race@x.ca", { marketingOptIn: true }),
      ),
    );

    const ok = results.filter((r): r is SaveSuccess => r.ok);
    expect(ok).toHaveLength(20);
    // One of them did the work; the rest were answered as retries.
    expect(ok.filter((r) => r.optedIn)).toHaveLength(1);
    expect(new Set(ok.map((r) => r.playerId)).size).toBe(1);
    expect(new Set(ok.map((r) => r.response.rank))).toEqual(new Set([1]));
    expect(new Set(ok.map((r) => JSON.stringify(r.response.best))).size).toBe(1);
    expect(new Set(ok.map((r) => r.response.playerToken)).size).toBe(20);

    expect(await db.players.countDocuments()).toBe(1);
    expect(await db.bestRuns.countDocuments()).toBe(1);
    expect(await db.consents.countDocuments({ kind: "terms_age" })).toBe(1);
    expect(await db.consents.countDocuments({ kind: "marketing" })).toBe(1);
    expect((await db.crmOutbox.find().toArray()).map((c) => c.type).sort()).toEqual([
      "consent_changed",
      "contact_upsert",
    ]);
    expect(await db.playerTokens.countDocuments()).toBe(20);
    expect(await db.runs.findOne({ _id: finished.runId })).toMatchObject({
      playerId: ok[0].playerId,
    });
  });

  it("gives the score to one of 20 emails racing for a token, and refuses the rest", async () => {
    const finished = await finish(db, GOOD());
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => attempt(finished.saveToken, `racer${i}@x.ca`)),
    );
    const winners = results.filter((r): r is SaveSuccess => r.ok);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual(
      Array.from({ length: 19 }, () => ({ ok: false, error: "expired" })),
    );
    expect(await db.runs.findOne({ _id: finished.runId })).toMatchObject({
      playerId: winners[0].playerId,
    });
    // One consent, one best run, one CRM row and one device token: the winner's.
    expect(await written()).toMatchObject({ tokens: 1, consents: 1, best: 1, crm: 1 });
  });
});

// A save either happens in full or not at all (see the file comment in scores.ts), so a save
// that is refused must leave the database as it found it, players included.
describe("POST /api/score: a refused save leaves nothing behind", () => {
  it("creates no player for another email that tries a spent token", async () => {
    const finished = await finish(db, GOOD());
    await save(db, finished, "owner@x.ca");
    const before = await written();
    expect(await attempt(finished.saveToken, "other@x.ca")).toEqual({
      ok: false,
      error: "expired",
    });
    expect(await db.players.countDocuments({ emailNormalized: "other@x.ca" })).toBe(0);
    expect(await written()).toEqual(before);
  });

  it("creates no player for another email that tries a known device's run", async () => {
    const { player } = await addRanked(db, { email: "known@x.ca", nickname: "Known", points: 10 });
    const finished = await finish(db, GOOD(), await issuePlayerToken(db, player._id));
    const before = await written();
    expect(await attempt(saveTokenFor(finished.runId), "someone-else@x.ca")).toEqual({
      ok: false,
      error: "expired",
    });
    expect(await db.players.countDocuments({ emailNormalized: "someone-else@x.ca" })).toBe(0);
    expect(await written()).toEqual(before);
  });

  it("leaves only the winner's player when 20 emails race for one token", async () => {
    const finished = await finish(db, GOOD());
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => attempt(finished.saveToken, `racer${i}@x.ca`)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await written()).toEqual({ players: 1, tokens: 1, consents: 1, best: 1, crm: 1 });
  });
});

describe("POST /api/score: what a save refuses", () => {
  const closings = [
    ["the leaderboard is switched off", { leaderboardOpen: false }],
    ["the contest has ended", { endsAt: new Date(Date.now() - 1000) }],
    ["the contest hasn't started", { startsAt: new Date(Date.now() + 86_400_000) }],
  ] as const;

  it.each(closings)("answers `closed` and writes nothing when %s", async (_, patch) => {
    // The run finished while the contest was open, so finish cached those settings. Saving
    // reads them fresh, so it still sees the change at once.
    const finished = await finish(db, GOOD());
    await db.campaignSettings.updateOne({}, { $set: patch });
    expect(await attempt(finished.saveToken, "late@x.ca")).toEqual({ ok: false, error: "closed" });
    expect(await written()).toEqual(EMPTY);

    // Nothing was spent: once the contest is open again, the same token works.
    await db.campaignSettings.updateOne(
      {},
      { $set: { leaderboardOpen: true, startsAt: ago(60), endsAt: null } },
    );
    expect((await attempt(finished.saveToken, "late@x.ca")).ok).toBe(true);
  });

  it("answers `expired` once the 30-minute window has passed", async () => {
    const finished = await finish(db, GOOD());
    const late = new Date(Date.now() + SAVE_WINDOW_MS + 60_000);
    expect(await attempt(finished.saveToken, "slow@x.ca", {}, late)).toEqual({
      ok: false,
      error: "expired",
    });
    expect(await attempt(saveTokenFor(finished.runId, Date.now() - 1), "slow@x.ca")).toEqual({
      ok: false,
      error: "expired",
    });
    expect(await written()).toEqual(EMPTY);

    // Inside the window it still works.
    const inside = new Date(Date.now() + SAVE_WINDOW_MS - 60_000);
    expect((await attempt(finished.saveToken, "slow@x.ca", {}, inside)).ok).toBe(true);
  });

  it("rejects a forged token, one of another kind, an unknown run and a flagged run", async () => {
    const finished = await finish(db, GOOD());
    const flagged = await finish(db, { ...GOOD(), garlic: 500 });
    expect(flagged.valid).toBe(false);
    const asRunToken = signToken("run", { v: 1, run: finished.runId, exp: Date.now() + 60_000 });
    for (const token of [
      `${finished.saveToken}x`,
      "nope",
      asRunToken,
      saveTokenFor(randomUUID()),
      saveTokenFor(flagged.runId),
    ]) {
      expect(await attempt(token, "a@x.ca")).toEqual({ ok: false, error: "rejected" });
    }
    await db.runs.updateOne({ _id: finished.runId }, { $set: { status: "flagged" } });
    expect(await attempt(finished.saveToken, "a@x.ca")).toEqual({ ok: false, error: "rejected" });
    expect(await written()).toEqual(EMPTY);
  });

  it("refuses disposable and malformed addresses and a missing terms box, creating nobody", async () => {
    const finished = await finish(db, GOOD());
    expect(await attempt(finished.saveToken, "x@mailinator.com")).toEqual({
      ok: false,
      error: "bad_email",
    });
    for (const email of ["not an email", "", "marie-ève@sympatico.ca", "a@b"]) {
      expect(await attempt(finished.saveToken, email)).toEqual({ ok: false, error: "rejected" });
    }
    expect(await attempt(finished.saveToken, "x@ok.ca", { termsAge: false })).toEqual({
      ok: false,
      error: "rejected",
    });
    expect(await written()).toEqual(EMPTY);

    // None of that spent the token, so the player can fix the form and try again.
    expect((await attempt(finished.saveToken, "fine@ok.ca")).ok).toBe(true);
  });
});

describe("POST /api/score: a player who comes back (SEC-07, LB-02, LB-07)", () => {
  it("keeps one player when an email saves again from a new device, and the better best run", async () => {
    const firstRun = await finish(db, GOOD(1));
    const first = await save(db, firstRun, "again@x.ca", { nickname: "Again" });

    // A worse run from another device: same player, same best, the run is still credited.
    const shortRun = await finish(db, SHORT(2));
    const worse = await save(db, shortRun, "again@x.ca");
    expect(worse.playerId).toBe(first.playerId);
    expect(worse.response.best).toEqual(first.response.best);
    expect(await db.bestRuns.findOne()).toMatchObject({ runId: firstRun.runId });
    expect(await db.runs.findOne({ _id: shortRun.runId })).toMatchObject({
      playerId: first.playerId,
    });

    // A better one replaces it.
    const betterRun = await finish(db, honestRun(3, 40, 12, 1));
    const better = await save(db, betterRun, "again@x.ca");
    expect(better.response.best!.points).toBeGreaterThan(first.response.best!.points);
    expect(better.response.rank).toBe(1);
    expect(await db.bestRuns.findOne()).toMatchObject({ runId: betterRun.runId });

    expect(await db.players.countDocuments()).toBe(1);
    expect(await db.bestRuns.countDocuments()).toBe(1);
    expect(await db.playerTokens.countDocuments({ playerId: first.playerId })).toBe(3);
  });

  it("keeps one player and the best run when several devices save different runs under a new email at once", async () => {
    const runs = [
      GOOD(1),
      honestRun(2, 40, 12),
      SHORT(3),
      honestRun(4, 20, 6),
      honestRun(5, 35, 9),
    ];
    const finished = await Promise.all(runs.map((run) => finish(db, run)));
    const results = await Promise.all(
      finished.map((f) => attempt(f.saveToken, "multi@x.ca", { marketingOptIn: true })),
    );
    const ok = results.filter((r): r is SaveSuccess => r.ok);
    expect(ok).toHaveLength(runs.length);
    expect(new Set(ok.map((r) => r.playerId)).size).toBe(1);

    const best = Math.max(...runs.map(pointsFor));
    expect(await db.bestRuns.find().toArray()).toEqual([expect.objectContaining({ points: best })]);
    expect(await db.players.countDocuments()).toBe(1);
    expect(await db.runs.countDocuments({ playerId: ok[0].playerId, savedAt: { $ne: null } })).toBe(
      runs.length,
    );
    // One new contact and one opt-in, however many saves; each save confirms the terms.
    expect(ok.filter((r) => r.optedIn)).toHaveLength(1);
    expect(await db.crmOutbox.countDocuments({ type: "contact_upsert" })).toBe(1);
    expect(await db.crmOutbox.countDocuments({ type: "consent_changed" })).toBe(1);
    expect(await db.consents.countDocuments({ kind: "terms_age" })).toBe(runs.length);
    expect(await db.consents.countDocuments({ kind: "marketing" })).toBe(1);
  });

  it("treats Gmail dots, plus tags and capitals as the same player", async () => {
    const a = await save(db, await finish(db, GOOD(1)), "sam.roy@gmail.com");
    const b = await save(db, await finish(db, GOOD(2)), "SamRoy+again@googlemail.com");
    expect(b.playerId).toBe(a.playerId);
    expect(await db.players.countDocuments()).toBe(1);
    // The address on file is the one first typed.
    expect((await db.players.findOne())!.email).toBe("sam.roy@gmail.com");
  });

  it("keeps a hidden player hidden when they come back with the same email", async () => {
    const first = await save(db, await finish(db, GOOD(1)), "hide@x.ca", { nickname: "Rude" });
    await db.players.updateOne({ _id: first.playerId }, { $set: { hidden: true } });

    const again = await save(db, await finish(db, GOOD(2)), "HIDE@x.ca");
    expect(again.playerId).toBe(first.playerId);
    expect(again.response.rank).toBeNull();
    expect((await db.players.findOne())!.hidden).toBe(true);
    expect(await topEntries(db, 10)).toEqual([]);
  });
});

describe("POST /api/score: nicknames (LB-05)", () => {
  const nicknameOf = async (email: string) =>
    (await db.players.findOne({ emailNormalized: email }))!.nickname;

  it("keeps a typed nickname, trimmed and with single spaces", async () => {
    await save(db, await finish(db, GOOD()), "nick@x.ca", { nickname: "  Éloïse   d'Or " });
    expect(await nicknameOf("nick@x.ca")).toBe("Éloïse d'Or");
  });

  it("gives a food name when the nickname is blank, too short, malformed or rude", async () => {
    const typed = [undefined, "", "   ", "a", "x".repeat(41), "<b>hi</b>", "emoji 🎮", "Merde 42"];
    for (const [i, nickname] of typed.entries()) {
      await save(db, await finish(db, SHORT(i + 1)), `blank${i}@x.ca`, { nickname });
      const given = (await nicknameOf(`blank${i}@x.ca`))!;
      expect(given, `${nickname}`).toMatch(/^\S+ \S+ \d{1,2}$/);
      // A food name always passes the rules, so a reroll on the form is always valid.
      expect(cleanNickname(given)).toBe(given);
    }
  });

  it("keeps the nickname a returning player has when the new save leaves it blank, and changes it when one is typed", async () => {
    await save(db, await finish(db, GOOD(1)), "back@x.ca", { nickname: "First Name" });
    await save(db, await finish(db, GOOD(2)), "back@x.ca", { nickname: "" });
    expect(await nicknameOf("back@x.ca")).toBe("First Name");
    await save(db, await finish(db, GOOD(3)), "back@x.ca", { nickname: "Second Name" });
    expect(await nicknameOf("back@x.ca")).toBe("Second Name");
    // A rude one doesn't replace it.
    await save(db, await finish(db, GOOD(4)), "back@x.ca", { nickname: "Merde 42" });
    expect(await nicknameOf("back@x.ca")).toBe("Second Name");
  });

  it("shows the nickname on the board", async () => {
    await save(db, await finish(db, GOOD()), "board@x.ca", { nickname: "Boardie" });
    expect(await topEntries(db, 10)).toEqual([
      { rank: 1, name: "Boardie", points: pointsFor(GOOD()) },
    ]);
  });
});

describe("entry before playing", () => {
  it("registers one player per normalized email without saving a score", async () => {
    const first = await saveScore(
      db,
      form("", "Entry.Player@gmail.com", { nickname: "Entry Player" }),
      { ...ctx(), now: new Date() },
      true,
    );
    const second = await saveScore(
      db,
      form("", "entryplayer+again@gmail.com", { nickname: "Entry Player" }),
      { ...ctx(), now: new Date() },
      true,
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.playerId).toBe(second.playerId);
    expect(await db.players.countDocuments()).toBe(1);
    expect(await db.bestRuns.countDocuments()).toBe(0);
    expect(await db.runs.countDocuments()).toBe(0);
    expect(first.response.best).toBeNull();
    const finished = await finish(db, GOOD());
    const saved = await save(db, finished, "entryplayer@gmail.com", { nickname: "Entry Player" });
    expect(saved.playerId).toBe(first.playerId);
    expect(await db.players.countDocuments()).toBe(1);
    expect(await db.bestRuns.countDocuments()).toBe(1);
  });
  it("rejects registration without a username or consent", async () => {
    for (const extra of [{ nickname: "" }, { nickname: "Entry Player", termsAge: false }]) {
      const result = await saveScore(
        db,
        form("", "entry@gmail.com", extra),
        { ...ctx(), now: new Date() },
        true,
      );
      expect(result).toEqual({ ok: false, error: "rejected" });
    }
    expect(await db.players.countDocuments()).toBe(0);
  });
});
