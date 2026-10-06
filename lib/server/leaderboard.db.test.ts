import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/leaderboard/route";
import { bestRuns, players, runs } from "@/db/schema";
import { TUNING } from "@/game-core";
import { BOTH, connect, finish, resetDb, seedCampaign } from "@/tests/db";
import { claimRewards } from "./claims";
import {
  cachedTop,
  clearBoardCache,
  entryOfPlayer,
  rankOfPlayer,
  rankPreview,
  topEntries,
} from "./leaderboard";

const { db, close } = connect();
afterAll(close);
beforeEach(async () => {
  await resetDb(db);
  await seedCampaign(db);
  clearBoardCache();
});

interface Score {
  name: string;
  garlic: number;
  hits: number;
  distanceM: number;
  /** Minutes ago the best run was set. */
  ago?: number;
  hidden?: boolean;
  deleted?: boolean;
}

/** A player with a best run, written directly (the claim path is covered elsewhere). */
async function addPlayer(s: Score) {
  const id = randomUUID();
  const runId = randomUUID();
  const at = new Date(Date.now() - (s.ago ?? 0) * 60_000);
  const handle = s.name.replace(/\W/g, "");
  await db.insert(players).values({
    id,
    email: `${handle}@example.com`,
    emailNormalized: `${handle.toLowerCase()}@example.com`,
    nickname: s.name,
    language: "en",
    hidden: s.hidden ?? false,
    deletedAt: s.deleted ? new Date() : null,
  });
  await db.insert(runs).values({
    id: runId,
    seed: 1,
    playerId: id,
    rules: { distanceM: 100, garlic: 10 },
    tuningVersion: TUNING.version,
    issuedAt: at,
    finishedAt: at,
    activeMs: 1000,
    distanceM: s.distanceM,
    garlic: s.garlic,
    hits: s.hits,
    status: "valid",
  });
  await db.insert(bestRuns).values({
    playerId: id,
    runId,
    garlic: s.garlic,
    hits: s.hits,
    distanceM: s.distanceM,
    achievedAt: at,
  });
  return id;
}

async function claimAs(claimToken: string, email: string, nickname?: string) {
  const res = await claimRewards(
    db,
    {
      claimToken,
      email,
      nickname,
      lang: "en",
      termsAge: true,
      marketingOptIn: false,
      src: null,
      utm: {},
    },
    { ip: null, userAgent: null, now: new Date() },
  );
  if (!res.ok) throw new Error(`claim failed: ${res.error}`);
  return res;
}

describe("leaderboard order (LB-01)", () => {
  it("ranks by garlic, then fewer hits, then distance, then whoever got there first", async () => {
    await addPlayer({ name: "far", garlic: 5, hits: 1, distanceM: 400 });
    await addPlayer({ name: "garlic", garlic: 9, hits: 5, distanceM: 120 });
    await addPlayer({ name: "clean", garlic: 5, hits: 0, distanceM: 150 });
    await addPlayer({ name: "late", garlic: 5, hits: 1, distanceM: 400, ago: 10 });
    await addPlayer({ name: "early", garlic: 5, hits: 1, distanceM: 400, ago: 30 });
    const top = await topEntries(db, 10);
    expect(top.map((e) => e.name)).toEqual(["garlic", "clean", "early", "late", "far"]);
    expect(top.map((e) => e.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it("shows whole metres and never an email (LB-04, LB-05)", async () => {
    await addPlayer({ name: "alex", garlic: 3, hits: 0, distanceM: 187.9 });
    const [entry] = await topEntries(db, 10);
    expect(entry).toEqual({ rank: 1, name: "alex", garlic: 3, hits: 0, distanceM: 187 });
    expect(JSON.stringify(entry)).not.toContain("@");
  });

  it("leaves out hidden and deleted players (LB-07)", async () => {
    await addPlayer({ name: "shown", garlic: 1, hits: 0, distanceM: 10 });
    const hidden = await addPlayer({
      name: "hidden",
      garlic: 20,
      hits: 0,
      distanceM: 900,
      hidden: true,
    });
    await addPlayer({ name: "gone", garlic: 19, hits: 0, distanceM: 900, deleted: true });
    expect((await topEntries(db, 10)).map((e) => e.name)).toEqual(["shown"]);
    expect(await rankOfPlayer(db, hidden)).toBeNull();
    expect(await entryOfPlayer(db, hidden)).toBeNull();
    expect(await rankPreview(db, { garlic: 0, hits: 9, distanceM: 1 }, null)).toBe(2);
  });

  it("ranks the same way as the top list for every player, ties included", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      ids.push(
        await addPlayer({
          name: `p${i}`,
          garlic: i % 3,
          hits: i % 2,
          distanceM: 100 + (i % 4),
          ago: i % 5,
        }),
      );
    }
    const top = await topEntries(db, 50);
    expect(top).toHaveLength(12);
    for (const id of ids) {
      const me = await entryOfPlayer(db, id);
      expect(top[me!.rank - 1].name).toBe(me!.name);
    }
  });
});

describe("only validated runs from players with an email (LB-03)", () => {
  it("adds a player after a claim, not after an anonymous finish", async () => {
    const anon = await finish(db, BOTH(1));
    expect(anon.rank).toBeNull();
    expect(await topEntries(db, 10)).toEqual([]);

    await claimAs(anon.claimToken!, "board@example.com", "Boardie");
    const top = await topEntries(db, 10);
    expect(top).toHaveLength(1);
    expect(top[0].name).toBe("Boardie");
  });

  it("returns the rank at finish once the device is known, and keeps one row per player (LB-02)", async () => {
    const first = await finish(db, BOTH(1));
    const claim = await claimAs(first.claimToken!, "repeat@example.com");
    const again = await finish(db, BOTH(2), claim.response.playerToken);
    expect(again.rank).toBe(1);
    expect(again.best).not.toBeNull();
    const rows = await db.select().from(bestRuns).where(eq(bestRuns.playerId, claim.playerId));
    expect(rows).toHaveLength(1);
  });
});

describe("GET /api/leaderboard (LB-04, LB-08)", () => {
  const get = (qs = "", headers: Record<string, string> = {}) =>
    GET(new Request(`https://game.test/api/leaderboard${qs}`, { headers }));
  const topOf = async (res: Response) => ((await res.json()) as { top: unknown[] }).top;

  it("returns the top 10 by default and honours ?limit, up to 50", async () => {
    for (let i = 0; i < 14; i++) {
      await addPlayer({ name: `p${i}`, garlic: 20 - i, hits: 0, distanceM: 100 });
    }
    expect(await topOf(await get())).toHaveLength(10);
    clearBoardCache();
    expect(await topOf(await get("?limit=3"))).toHaveLength(3);
    clearBoardCache();
    expect(await topOf(await get("?limit=500"))).toHaveLength(14);
    expect((await get("?limit=abc")).status).toBe(400);
    expect((await get("?limit=0")).status).toBe(400);
  });

  it("serves the public list from a 30 s cache", async () => {
    const t0 = Date.now();
    await addPlayer({ name: "first", garlic: 5, hits: 0, distanceM: 100 });
    expect((await cachedTop(db, 10, t0)).map((e) => e.name)).toEqual(["first"]);
    await addPlayer({ name: "second", garlic: 9, hits: 0, distanceM: 100 });
    expect((await cachedTop(db, 10, t0 + 29_000)).map((e) => e.name)).toEqual(["first"]);
    expect((await cachedTop(db, 10, t0 + 31_000)).map((e) => e.name)).toEqual(["second", "first"]);
  });

  it("adds `me`, computed fresh, for a known device even outside the top list", async () => {
    for (let i = 0; i < 12; i++) {
      await addPlayer({ name: `p${i}`, garlic: 30 - i, hits: 0, distanceM: 100 });
    }
    const first = await finish(db, BOTH(1));
    const claim = await claimAs(first.claimToken!, "me@example.com", "Me Myself");
    const res = await get("?limit=10", { "x-player-token": claim.response.playerToken });
    const body = (await res.json()) as { top: unknown[]; me?: { rank: number; name: string } };
    expect(body.top).toHaveLength(10);
    expect(body.me).toMatchObject({ name: "Me Myself", rank: 13 });
    const anon = (await (await get("?limit=10")).json()) as { me?: unknown };
    expect(anon.me).toBeUndefined();
  });
});
