import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { insertOnce, isDuplicateKey } from "@/db/client";
import { newCampaignSettings, newCrmOutbox, newPlayer } from "@/db/schema";
import { connect, resetDb } from "@/tests/db";

const { db, close } = connect(30);
afterAll(close);
beforeEach(() => resetDb(db));

const player = (name: string) =>
  newPlayer({ email: `${name}@x.ca`, emailNormalized: `${name}@x.ca`, language: "fr" });

describe("transactions", () => {
  it("commit everything the callback wrote, and return its result", async () => {
    const result = await db.transaction(async (tx) => {
      await tx.players.insertOne(player("a"));
      await tx.players.insertOne(player("b"));
      return "done";
    });
    expect(result).toBe("done");
    expect(await db.players.countDocuments()).toBe(2);
  });

  it("roll back everything when the callback throws", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.players.insertOne(player("a"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.players.countDocuments()).toBe(0);
  });

  it("see their own writes, which stay hidden from everyone else until the commit", async () => {
    await db.transaction(async (tx) => {
      await tx.players.insertOne(player("a"));
      expect(await tx.players.countDocuments()).toBe(1);
      expect(await db.players.countDocuments()).toBe(0);
    });
    expect(await db.players.countDocuments()).toBe(1);
  });

  it("run every call through the session, and refuse the ones they can't bind", async () => {
    await db.transaction(async (tx) => {
      expect(() => tx.players.watch()).toThrow(/isn't supported inside a transaction/);
      await tx.players.insertOne(player("a"));
      await tx.players.updateOne({ emailNormalized: "a@x.ca" }, { $set: { hidden: true } });
      await tx.players.bulkWrite([
        {
          updateOne: { filter: { emailNormalized: "a@x.ca" }, update: { $set: { hidden: false } } },
        },
      ]);
      expect(await tx.players.find({ hidden: false }).toArray()).toHaveLength(1);
      expect(await tx.players.aggregate([{ $count: "n" }]).toArray()).toEqual([{ n: 1 }]);
    });
    // None of it leaked out of the transaction early: it all committed together.
    expect((await db.players.findOne())!.hidden).toBe(false);
  });

  it("run again after a write conflict, so concurrent read-modify-writes lose nothing", async () => {
    const row = newCrmOutbox({
      playerId: "p",
      type: "contact_upsert",
      payload: {},
      idempotencyKey: "counter",
    });
    await db.crmOutbox.insertOne(row);
    let calls = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        db.transaction(async (tx) => {
          calls++;
          const current = (await tx.crmOutbox.findOne({ _id: row._id }))!;
          await tx.crmOutbox.updateOne(
            { _id: row._id },
            { $set: { attempts: current.attempts + 1 } },
          );
        }),
      ),
    );
    expect((await db.crmOutbox.findOne({ _id: row._id }))!.attempts).toBe(20);
    expect(calls).toBeGreaterThanOrEqual(20);
  });
});

describe("insertOnce", () => {
  it("inserts a document once and says whether it did", async () => {
    const a = player("a");
    expect(await insertOnce(db.players, { emailNormalized: a.emailNormalized }, a)).toBe(true);
    expect(
      await insertOnce(db.players, { emailNormalized: a.emailNormalized }, { ...a, _id: "other" }),
    ).toBe(false);
    expect(await db.players.countDocuments()).toBe(1);
    expect((await db.players.findOne())!._id).toBe(a._id);
  });

  it("works inside a transaction, where a duplicate key would abort it", async () => {
    const a = player("a");
    await db.players.insertOne(a);
    await db.transaction(async (tx) => {
      expect(
        await insertOnce(
          tx.players,
          { emailNormalized: a.emailNormalized },
          { ...a, _id: "again" },
        ),
      ).toBe(false);
      const b = player("b");
      expect(await insertOnce(tx.players, { emailNormalized: b.emailNormalized }, b)).toBe(true);
    });
    expect(await db.players.countDocuments()).toBe(2);
  });

  it("lets only one of many concurrent inserts of the same key win", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const doc = { ...player("race"), _id: `p${i}` };
        return db.transaction((tx) =>
          insertOnce(tx.players, { emailNormalized: doc.emailNormalized }, doc),
        );
      }),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db.players.countDocuments()).toBe(1);
  });
});

// What the CHECK constraints guarded, now validators and unique indexes (db/schema.ts).
describe("the schema's checks", () => {
  it("keeps the campaign settings to one document with a retention that makes sense", async () => {
    await db.campaignSettings.insertOne(newCampaignSettings());
    await expect(db.campaignSettings.insertOne(newCampaignSettings({ _id: 2 }))).rejects.toThrow(
      /validation/i,
    );
    await expect(
      db.campaignSettings.updateOne({ _id: 1 }, { $set: { retentionDays: -1 } }),
    ).rejects.toThrow(/validation/i);
    await db.campaignSettings.updateOne({ _id: 1 }, { $set: { retentionDays: 0 } });
  });

  it("starts the contest with the leaderboard off", () => {
    expect(newCampaignSettings()).toMatchObject({
      _id: 1,
      startsAt: null,
      endsAt: null,
      leaderboardOpen: false,
      retentionDays: 90,
    });
  });

  it("only knows the run statuses it should", async () => {
    await expect(
      db.runs.updateOne({ _id: "none" }, { $set: { status: "maybe" } }, { upsert: true }),
    ).rejects.toThrow(/validation/i);
  });

  it("keeps one player per normalized email, one CRM row per key and one best run per player (SEC-07)", async () => {
    const a = player("a");
    await db.players.insertOne(a);
    await expect(
      db.players.insertOne({ ...player("other"), emailNormalized: a.emailNormalized }),
    ).rejects.toThrow(/duplicate key/);

    const crm = { playerId: a._id, type: "contact_upsert", payload: {}, idempotencyKey: "k" };
    await db.crmOutbox.insertOne(newCrmOutbox(crm));
    await expect(db.crmOutbox.insertOne(newCrmOutbox(crm))).rejects.toThrow(/duplicate key/);

    const best = {
      _id: a._id,
      runId: "r",
      points: 10,
      distanceM: 10,
      garlic: 0,
      achievedAt: new Date(),
    };
    await db.bestRuns.insertOne(best);
    await expect(db.bestRuns.insertOne({ ...best, runId: "r2" })).rejects.toThrow(/duplicate key/);
  });

  it("recognizes a duplicate key, and nothing else", async () => {
    const a = player("a");
    await db.players.insertOne(a);
    const error = await db.players.insertOne({ ...a, _id: "other" }).catch((e: unknown) => e);
    expect(isDuplicateKey(error)).toBe(true);
    expect(isDuplicateKey(new Error("nope"))).toBe(false);
    expect(isDuplicateKey({ code: 121 })).toBe(false);
    expect(isDuplicateKey(null)).toBe(false);
  });
});
