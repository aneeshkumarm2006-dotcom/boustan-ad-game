import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/leaderboard/route";
import type { Db } from "@/db/client";
import { BEST_RUNS_RANK_INDEX, newPlayer, type BestRunDoc } from "@/db/schema";
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
} from "@/tests/db";
import { resetEnvForTests } from "./env";
import {
  BOARD_CACHE_MS,
  RANK_ORDER,
  cachedTop,
  clearBoardCache,
  entryOfPlayer,
  rankOfPlayer,
  rankPreview,
  topEntries,
  updateBestRun,
} from "./leaderboard";

const { db, close } = connect();
afterAll(close);
beforeEach(async () => {
  await resetDb(db);
  await seedCampaign(db);
});

/** A moment `minutes` ago: earlier moments rank ahead on equal points. */
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const names = async (limit = 50) => (await topEntries(db, limit)).map((e) => e.name);

/** Puts a player on the board without clearing the cache, as another server instance would. */
async function addQuietly(email: string, nickname: string, points: number) {
  const player = newPlayer({ email, emailNormalized: email, language: "en", nickname });
  await db.players.insertOne(player);
  await db.bestRuns.insertOne({
    _id: player._id,
    runId: randomUUID(),
    points,
    distanceM: points,
    garlic: 0,
    achievedAt: new Date(),
  });
  return player;
}

describe("leaderboard order (LB-01)", () => {
  it("ranks by points, then whoever got there first, then the player id", async () => {
    await addRanked(db, { email: "low@x.ca", nickname: "low", points: 50 });
    await addRanked(db, { email: "high@x.ca", nickname: "high", points: 400, achievedAt: ago(5) });
    await addRanked(db, { email: "late@x.ca", nickname: "late", points: 120, achievedAt: ago(10) });
    await addRanked(db, {
      email: "early@x.ca",
      nickname: "early",
      points: 120,
      achievedAt: ago(30),
    });
    // Equal points at the very same moment: the player id decides.
    const same = ago(60);
    for (const id of ["b", "a"]) {
      await addRanked(db, {
        email: `${id}@x.ca`,
        nickname: `id-${id}`,
        points: 120,
        achievedAt: same,
        _id: id,
      });
    }

    const top = await topEntries(db, 10);
    expect(top.map((e) => e.name)).toEqual(["high", "id-a", "id-b", "early", "late", "low"]);
    expect(top.map((e) => e.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(top.map((e) => e.points)).toEqual([400, 120, 120, 120, 120, 50]);
  });

  it("is served by the best_runs index, without sorting the whole collection", async () => {
    expect(Object.entries(BEST_RUNS_RANK_INDEX.key)).toEqual(Object.entries(RANK_ORDER));
    await addRanked(db, { email: "a@x.ca", nickname: "a", points: 10 });
    await addRanked(db, { email: "b@x.ca", nickname: "b", points: 20 });
    for (const filter of [{}, { _id: { $nin: ["somebody"] } }]) {
      const plan = await db.bestRuns.find(filter).sort(RANK_ORDER).limit(3).explain("queryPlanner");
      const winning = JSON.stringify(plan.queryPlanner.winningPlan);
      expect(winning).toContain(BEST_RUNS_RANK_INDEX.options.name);
      expect(winning).not.toContain('"SORT"');
    }
  });

  it("shows a name and points, and never an email (LB-04, LB-05)", async () => {
    const { player } = await addRanked(db, {
      email: "alex@example.com",
      nickname: "alex",
      points: 283,
      garlic: 12,
    });
    expect(await topEntries(db, 10)).toEqual([{ rank: 1, name: "alex", points: 283 }]);
    expect(await entryOfPlayer(db, player._id)).toEqual({ rank: 1, name: "alex", points: 283 });
    expect(JSON.stringify(await topEntries(db, 10))).not.toContain("@");
  });

  it("names a player who has no nickname with a dash", async () => {
    await addRanked(db, { email: "anon@example.com", nickname: null, points: 5 });
    expect((await topEntries(db, 10))[0].name).toBe("—");
  });

  it("returns at most the limit, in order, and nothing on an empty board", async () => {
    expect(await topEntries(db, 10)).toEqual([]);
    for (let i = 0; i < 6; i++) {
      await addRanked(db, { email: `p${i}@x.ca`, nickname: `p${i}`, points: i * 10 });
    }
    expect(await names(3)).toEqual(["p5", "p4", "p3"]);
  });
});

describe("rank and order agree for everyone, ties included (LB-01, LB-08)", () => {
  /** A seeded generator, so a failure repeats. */
  function random(seed: number) {
    let s = seed >>> 0;
    return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000;
  }

  it("gives each of 40 players, with plenty of equal scores, the position the list shows", async () => {
    const rand = random(2026);
    const base = Date.now() - 3_600_000;
    const rows: BestRunDoc[] = [];
    const nameOf = new Map<string, string>();
    for (let i = 0; i < 40; i++) {
      const { best } = await addRanked(db, {
        email: `p${i}@x.ca`,
        nickname: `p${i}`,
        points: Math.floor(rand() * 5) * 10,
        achievedAt: new Date(base + Math.floor(rand() * 3) * 1000),
      });
      rows.push(best);
      nameOf.set(best._id, `p${i}`);
    }
    // Hidden players take no position, and leave no gap.
    for (let i = 0; i < 3; i++) {
      await addRanked(db, { email: `h${i}@x.ca`, nickname: `h${i}`, points: 1000, hidden: true });
    }

    const order = (a: BestRunDoc, b: BestRunDoc) =>
      b.points - a.points ||
      a.achievedAt.getTime() - b.achievedAt.getTime() ||
      (a._id < b._id ? -1 : a._id > b._id ? 1 : 0);
    const expected = [...rows].sort(order).map((r) => nameOf.get(r._id));

    const top = await topEntries(db, 50);
    expect(top.map((e) => e.name)).toEqual(expected);
    expect(top.map((e) => e.rank)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    for (const row of rows) {
      const entry = (await entryOfPlayer(db, row._id))!;
      expect(entry.rank).toBe(expected.indexOf(nameOf.get(row._id)) + 1);
      expect(top[entry.rank - 1]).toEqual(entry);
      expect(await rankOfPlayer(db, row._id)).toBe(entry.rank);
    }
  });

  it("ranks players with the same points and the same moment by their ids", async () => {
    const same = ago(1);
    for (const id of ["c", "a", "b"]) {
      await addRanked(db, {
        email: `${id}@x.ca`,
        nickname: id,
        points: 77,
        achievedAt: same,
        _id: id,
      });
    }
    expect(await names()).toEqual(["a", "b", "c"]);
    expect(await Promise.all(["a", "b", "c"].map((id) => rankOfPlayer(db, id)))).toEqual([1, 2, 3]);
  });
});

describe("hidden players (LB-07)", () => {
  it("are left out of the list, the ranks and the preview", async () => {
    await addRanked(db, { email: "shown@x.ca", nickname: "shown", points: 10 });
    const { player: hidden } = await addRanked(db, {
      email: "hidden@x.ca",
      nickname: "hidden",
      points: 900,
      hidden: true,
    });
    await addRanked(db, { email: "second@x.ca", nickname: "second", points: 5 });

    expect(await names()).toEqual(["shown", "second"]);
    expect(await rankOfPlayer(db, hidden._id)).toBeNull();
    expect(await entryOfPlayer(db, hidden._id)).toBeNull();
    // The hidden 900 doesn't push anyone down: a score of 8 comes second, not third.
    expect(await rankPreview(db, { points: 8 }, null)).toBe(2);
    expect(await rankPreview(db, { points: 1000 }, null)).toBe(1);
  });

  it("come back onto the board when they are shown again", async () => {
    const { player } = await addRanked(db, {
      email: "back@x.ca",
      nickname: "back",
      points: 50,
      hidden: true,
    });
    expect(await topEntries(db, 10)).toEqual([]);
    await db.players.updateOne({ _id: player._id }, { $set: { hidden: false } });
    expect(await topEntries(db, 10)).toEqual([{ rank: 1, name: "back", points: 50 }]);
    expect(await rankOfPlayer(db, player._id)).toBe(1);
  });
});

describe("the rank a score would take (LB-08)", () => {
  it("is first on an empty board", async () => {
    expect(await rankPreview(db, { points: 0 }, null)).toBe(1);
  });

  it("puts a new score behind equal ones, which got there first", async () => {
    await addRanked(db, { email: "a@x.ca", nickname: "a", points: 100 });
    await addRanked(db, { email: "b@x.ca", nickname: "b", points: 100 });
    await addRanked(db, { email: "c@x.ca", nickname: "c", points: 40 });
    expect(await rankPreview(db, { points: 101 }, null)).toBe(1);
    expect(await rankPreview(db, { points: 100 }, null)).toBe(3);
    expect(await rankPreview(db, { points: 99 }, null)).toBe(3);
    expect(await rankPreview(db, { points: 40 }, null)).toBe(4);
    expect(await rankPreview(db, { points: 0 }, null)).toBe(4);
  });

  it("leaves out the player's own best run, so it agrees with their rank", async () => {
    const { player } = await addRanked(db, { email: "me@x.ca", nickname: "me", points: 100 });
    await addRanked(db, { email: "top@x.ca", nickname: "top", points: 300 });
    expect(await rankPreview(db, { points: 100 }, null)).toBe(3);
    expect(await rankPreview(db, { points: 100 }, player._id)).toBe(2);
    expect(await rankPreview(db, { points: 500 }, player._id)).toBe(1);
  });
});

describe("a player's best run (LB-02)", () => {
  const score = (points: number, extra: { garlic?: number; at?: Date } = {}) => ({
    points,
    distanceM: points - (extra.garlic ?? 0) * 10,
    garlic: extra.garlic ?? 0,
    runId: randomUUID(),
    at: extra.at ?? new Date(),
  });
  const stored = async (id: string) => (await db.bestRuns.findOne({ _id: id }))!;

  it("is stored as the player's id, the run, its score and when it was reached", async () => {
    const id = randomUUID();
    const first = score(100, { garlic: 4, at: ago(3) });
    await updateBestRun(db, id, first);
    expect(await stored(id)).toEqual({
      _id: id,
      runId: first.runId,
      points: 100,
      distanceM: 60,
      garlic: 4,
      achievedAt: first.at,
    });
  });

  it("is replaced only by a strictly better run", async () => {
    const id = randomUUID();
    const first = score(100);
    await updateBestRun(db, id, first);
    // Not better: fewer points, or the same.
    for (const worse of [score(99), score(100), score(0)]) {
      await updateBestRun(db, id, worse);
      expect((await stored(id)).runId).toBe(first.runId);
    }
    // Better: one more point is enough, and so is a lot more.
    for (const better of [score(101), score(5000)]) {
      await updateBestRun(db, id, better);
      expect((await stored(id)).runId).toBe(better.runId);
    }
    expect(await db.bestRuns.countDocuments({ _id: id })).toBe(1);
  });

  it("is replaced as a whole, with nothing left over from the old run", async () => {
    const id = randomUUID();
    await updateBestRun(db, id, score(100, { garlic: 9, at: ago(60) }));
    const better = score(300, { garlic: 0, at: ago(1) });
    await updateBestRun(db, id, better);
    expect(await stored(id)).toEqual({
      _id: id,
      runId: better.runId,
      points: 300,
      distanceM: 300,
      garlic: 0,
      achievedAt: better.at,
    });
  });

  it("keeps the earlier time on an equal score, so whoever got there first stays ahead", async () => {
    const { player } = await addRanked(db, { email: "early@x.ca", nickname: "early", points: 100 });
    await addRanked(db, { email: "other@x.ca", nickname: "other", points: 100 });
    const before = await stored(player._id);
    await updateBestRun(db, player._id, score(100, { at: new Date(Date.now() + 5000) }));
    expect(await stored(player._id)).toEqual(before);
    expect(await names()).toEqual(["early", "other"]);
  });

  it("keeps the best of runs that finish at the same moment", async () => {
    const id = randomUUID();
    const runs = Array.from({ length: 30 }, (_, i) => score((i * 7) % 50));
    await Promise.all(runs.map((r) => updateBestRun(db, id, r)));
    const best = Math.max(...runs.map((r) => r.points));
    expect(await stored(id)).toMatchObject({ points: best });
    expect(await db.bestRuns.countDocuments({ _id: id })).toBe(1);
  });

  it("keeps one row for each of many players finishing at the same moment", async () => {
    const ids = Array.from({ length: 20 }, () => randomUUID());
    await Promise.all(
      ids.flatMap((id, i) => [score(i), score(i + 100)].map((s) => updateBestRun(db, id, s))),
    );
    expect(await db.bestRuns.countDocuments()).toBe(20);
    for (const [i, id] of ids.entries()) {
      expect(await stored(id)).toMatchObject({ points: i + 100 });
    }
  });
});

describe("who is on the board (LB-03)", () => {
  it("adds a player once their score is saved, not after an anonymous finish", async () => {
    const anon = await finish(db, GOOD(1));
    expect(anon.rank).toBeNull();
    expect(await topEntries(db, 10)).toEqual([]);

    await save(db, anon, "board@example.com", { nickname: "Boardie" });
    expect(await topEntries(db, 10)).toEqual([
      { rank: 1, name: "Boardie", points: pointsFor(GOOD(1)) },
    ]);
  });

  it("keeps one row per player however many runs they play, ranked by their best", async () => {
    const saved = await save(db, await finish(db, SHORT(1)), "repeat@example.com", {
      nickname: "Repeat",
    });
    const token = saved.response.playerToken;
    await finish(db, GOOD(2), token);
    const worse = await finish(db, SHORT(3), token);
    expect(worse.rank).toBe(1);
    expect(worse.best).toMatchObject({ points: pointsFor(GOOD(2)) });
    expect(await db.bestRuns.countDocuments({ _id: saved.playerId })).toBe(1);
    expect(await topEntries(db, 10)).toEqual([
      { rank: 1, name: "Repeat", points: pointsFor(GOOD(2)) },
    ]);
  });
});

describe("the public list is cached for 30 s (LB-08)", () => {
  it("serves a list up to 30 s old, then a fresh one", async () => {
    expect(BOARD_CACHE_MS).toBe(30_000);
    const t0 = Date.now();
    await addRanked(db, { email: "first@x.ca", nickname: "first", points: 50 });
    expect((await cachedTop(db, 10, t0)).map((e) => e.name)).toEqual(["first"]);
    await addQuietly("second@x.ca", "second", 90);
    expect((await cachedTop(db, 10, t0 + 29_000)).map((e) => e.name)).toEqual(["first"]);
    expect((await cachedTop(db, 10, t0 + 31_000)).map((e) => e.name)).toEqual(["second", "first"]);
  });

  it("keeps a separate list for each size", async () => {
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) {
      await addRanked(db, { email: `p${i}@x.ca`, nickname: `p${i}`, points: i });
    }
    expect(await cachedTop(db, 2, t0)).toHaveLength(2);
    expect(await cachedTop(db, 5, t0)).toHaveLength(5);
  });

  it("starts over when the cache is cleared", async () => {
    const t0 = Date.now();
    await addRanked(db, { email: "first@x.ca", nickname: "first", points: 50 });
    await cachedTop(db, 10, t0);
    await addQuietly("second@x.ca", "second", 90);
    expect((await cachedTop(db, 10, t0 + 1000)).map((e) => e.name)).toEqual(["first"]);
    clearBoardCache();
    expect((await cachedTop(db, 10, t0 + 2000)).map((e) => e.name)).toEqual(["second", "first"]);
  });

  it("doesn't keep a list that failed to load", async () => {
    const t0 = Date.now();
    await addRanked(db, { email: "first@x.ca", nickname: "first", points: 50 });
    const broken = new Proxy({} as Db, {
      get() {
        throw new Error("database is down");
      },
    });
    await expect(cachedTop(broken, 10, t0)).rejects.toThrow("database is down");
    expect((await cachedTop(db, 10, t0 + 1000)).map((e) => e.name)).toEqual(["first"]);
  });
});

describe("GET /api/leaderboard (LB-04, LB-08)", () => {
  const get = (qs = "", headers: Record<string, string> = {}) =>
    GET(new Request(`https://game.test/api/leaderboard${qs}`, { headers }));
  type Entry = { rank: number; name: string; points: number };
  const bodyOf = async (res: Response) => (await res.json()) as { top: Entry[]; me?: Entry };

  it("returns the top 10 by default and honours ?limit, up to 50", async () => {
    for (let i = 0; i < 14; i++) {
      await addRanked(db, { email: `p${i}@x.ca`, nickname: `p${i}`, points: 200 - i });
    }
    const first = await get();
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect((await bodyOf(first)).top).toHaveLength(10);
    clearBoardCache();
    expect((await bodyOf(await get("?limit=3"))).top).toHaveLength(3);
    clearBoardCache();
    expect((await bodyOf(await get("?limit=500"))).top).toHaveLength(14);
    expect((await get("?limit=abc")).status).toBe(400);
    expect((await get("?limit=0")).status).toBe(400);
  });

  it("lists rank, name and points only", async () => {
    await addRanked(db, { email: "secret@example.com", nickname: "Public", points: 150 });
    const text = await (await get()).text();
    expect(JSON.parse(text)).toEqual({ top: [{ rank: 1, name: "Public", points: 150 }] });
    expect(text).not.toContain("secret");
  });

  it("adds `me`, computed fresh, for a known device even outside the top list", async () => {
    for (let i = 0; i < 12; i++) {
      await addRanked(db, { email: `p${i}@x.ca`, nickname: `p${i}`, points: 1000 - i });
    }
    const saved = await save(db, await finish(db, GOOD(1)), "me@example.com", {
      nickname: "Me Myself",
    });
    const headers = { "x-player-token": saved.response.playerToken };

    const res = await bodyOf(await get("?limit=10", headers));
    expect(res.top).toHaveLength(10);
    expect(res.me).toEqual({ rank: 13, name: "Me Myself", points: pointsFor(GOOD(1)) });
    expect((await bodyOf(await get("?limit=10"))).me).toBeUndefined();

    // Somebody passes them. The list is up to 30 s old, but their own rank is not.
    await addQuietly("late@x.ca", "late", 5000);
    const again = await bodyOf(await get("?limit=10", headers));
    expect(again.top).toEqual(res.top);
    expect(again.me!.rank).toBe(14);
  });

  it("leaves out `me` for a device token it doesn't know", async () => {
    await addRanked(db, { email: "a@x.ca", nickname: "a", points: 5 });
    const res = await bodyOf(await get("", { "x-player-token": "not-a-real-token" }));
    expect(res.me).toBeUndefined();
    expect(res.top).toHaveLength(1);
  });

  it("answers 429 with a retry time once an address asks too often", async () => {
    const before = process.env.RATE_LIMITS;
    process.env.RATE_LIMITS = "leaderboard=3/60";
    resetEnvForTests();
    try {
      for (let i = 0; i < 3; i++) expect((await get()).status).toBe(200);
      const res = await get();
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    } finally {
      if (before === undefined) delete process.env.RATE_LIMITS;
      else process.env.RATE_LIMITS = before;
      resetEnvForTests();
    }
  });
});
