import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { newConsent } from "@/db/schema";
import { GOOD, connect, finish, resetDb, save, seedCampaign } from "@/tests/db";
import { erasePlayer } from "./admin/players";
import { consentText, recordConsent } from "./consent";

const { db, close } = connect();
afterAll(close);
beforeEach(async () => {
  await resetDb(db);
  await seedCampaign(db);
});

async function optedInPlayer() {
  const res = await save(db, await finish(db, GOOD()), "news@fan.ca", {
    lang: "fr",
    marketingOptIn: true,
  });
  return res.playerId;
}

describe("recording a consent (DATA-03, L10N-07)", () => {
  it("keeps exactly what the player saw: text, version, language, source, IP, device and host", async () => {
    await recordConsent(db, {
      playerId: "p1",
      kind: "marketing",
      lang: "fr",
      source: "save_form",
      ip: "203.0.113.9",
      userAgent: "Mozilla/5.0 (test)",
      hostOrigin: "https://news.example",
    });
    const { text, version } = consentText("fr", "marketing");
    expect(await db.consents.findOne()).toMatchObject({
      playerId: "p1",
      kind: "marketing",
      granted: true,
      text,
      textVersion: version,
      language: "fr",
      source: "save_form",
      ip: "203.0.113.9",
      userAgent: "Mozilla/5.0 (test)",
      hostOrigin: "https://news.example",
    });
  });

  it("only ever records a grant: the app has no way to withdraw a consent", async () => {
    for (const kind of ["terms_age", "marketing"] as const) {
      await recordConsent(db, {
        playerId: "p1",
        kind,
        lang: "en",
        source: "save_form",
        ip: null,
        userAgent: null,
        hostOrigin: null,
      });
    }
    expect((await db.consents.find().toArray()).map((c) => c.granted)).toEqual([true, true]);
  });

  it("cuts a very long user agent to 400 characters", async () => {
    await recordConsent(db, {
      playerId: "p1",
      kind: "terms_age",
      lang: "en",
      source: "save_form",
      ip: null,
      userAgent: "x".repeat(500),
      hostOrigin: null,
    });
    expect((await db.consents.findOne())!.userAgent).toHaveLength(400);
  });
});

// MongoDB has no trigger to refuse an UPDATE, so the log is append-only by construction: the app
// only ever inserts consent rows, and its database user has no `update` on the collection
// (db/roles.ts, checked in db/roles.db.test.ts).
describe("consent log is append-only (DATA-03)", () => {
  it("only gains rows: a later save adds its own, and earlier ones are never rewritten", async () => {
    await optedInPlayer();
    const before = await db.consents.find().sort({ _id: 1 }).toArray();
    expect(before.map((c) => [c.kind, c.granted])).toEqual([
      ["terms_age", true],
      ["marketing", true],
    ]);

    // The same person saves another run from another device.
    await save(db, await finish(db, GOOD(2)), "news@fan.ca", { lang: "fr", marketingOptIn: true });
    const after = await db.consents.find().sort({ _id: 1 }).toArray();
    expect(after).toHaveLength(3);
    expect(after.slice(0, 2)).toEqual(before);
    // The new row is the age and terms confirmation; the marketing consent was already granted.
    expect(after[2]).toMatchObject({ kind: "terms_age", granted: true });
  });

  it("is emptied for a player only by erasing that player (DATA-07)", async () => {
    const playerId = await optedInPlayer();
    expect(await db.consents.countDocuments({ playerId })).toBe(2);
    expect(await erasePlayer(db, playerId)).toMatchObject({ consentRows: 2 });
    expect(await db.consents.countDocuments({ playerId })).toBe(0);
  });

  it("only knows the two kinds of consent", async () => {
    const row = {
      playerId: "p1",
      granted: true,
      text: "…",
      textVersion: "v1",
      language: "fr",
      source: "save_form",
    };
    await db.consents.insertOne(newConsent({ ...row, kind: "marketing" }));
    await db.consents.insertOne(newConsent({ ...row, kind: "terms_age" }));
    await expect(db.consents.insertOne(newConsent({ ...row, kind: "other" }))).rejects.toThrow(
      /validation/i,
    );
  });
});
