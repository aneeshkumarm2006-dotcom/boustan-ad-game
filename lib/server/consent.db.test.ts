import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { newConsent } from "@/db/schema";
import { BOTH, connect, ctx, finish, resetDb, seedCampaign } from "@/tests/db";
import { erasePlayer } from "./admin/players";
import { claimRewards } from "./claims";
import { signToken } from "./tokens";
import { unsubscribe } from "./unsubscribe";

const { db, close } = connect();
afterAll(close);
beforeEach(async () => {
  await resetDb(db);
  await seedCampaign(db);
});

async function optedInPlayer() {
  const run = await finish(db, BOTH());
  const res = await claimRewards(
    db,
    {
      claimToken: run.claimToken!,
      email: "news@fan.ca",
      lang: "fr",
      termsAge: true,
      marketingOptIn: true,
      src: null,
      utm: {},
    },
    ctx(),
  );
  if (!res.ok) throw new Error(res.error);
  return res.playerId;
}

// MongoDB has no trigger to refuse an UPDATE, so the log is append-only by construction: the app
// only ever inserts consent rows, and its database user has no `update` on the collection
// (db/roles.ts, checked in db/roles.db.test.ts).
describe("consent log is append-only (DATA-03)", () => {
  it("only gains rows: a withdrawal is a new row, and earlier ones are never rewritten", async () => {
    const playerId = await optedInPlayer();
    const before = await db.consents.find().sort({ _id: 1 }).toArray();
    expect(before).toHaveLength(2);

    await unsubscribe(db, signToken("unsubscribe", { v: 1, p: playerId }), ctx());
    await unsubscribe(db, signToken("unsubscribe", { v: 1, p: playerId }), ctx());

    const after = await db.consents.find().sort({ _id: 1 }).toArray();
    expect(after).toHaveLength(4);
    expect(after.slice(0, 2)).toEqual(before);
    expect(after.slice(2).map((c) => [c.kind, c.granted])).toEqual([
      ["marketing", false],
      ["marketing", false],
    ]);
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
      source: "claim_form",
    };
    await db.consents.insertOne(newConsent({ ...row, kind: "marketing" }));
    await expect(db.consents.insertOne(newConsent({ ...row, kind: "other" }))).rejects.toThrow(
      /validation/i,
    );
  });
});

describe("unsubscribe link (DATA-07, AC-07)", () => {
  it("logs a withdrawal, turns marketing off and queues it for the CRM", async () => {
    const playerId = await optedInPlayer();
    const token = signToken("unsubscribe", { v: 1, p: playerId });
    expect(await unsubscribe(db, token, ctx())).toEqual({ lang: "fr" });

    const player = (await db.players.findOne({ _id: playerId }))!;
    expect(player.marketingOptIn).toBe(false);
    const rows = await db.consents.find().sort({ _id: 1 }).toArray();
    expect(rows.at(-1)).toMatchObject({
      kind: "marketing",
      granted: false,
      source: "unsubscribe",
      language: "fr",
      ip: "203.0.113.7",
      text: "Désabonnement des offres et nouvelles de Boustan par courriel.",
    });
    const crm = await db.crmOutbox.find({ type: "consent_changed" }).sort({ _id: 1 }).toArray();
    expect(crm.map((c) => c.payload.marketing)).toEqual([true, false]);
  });

  it("ignores links that are forged or for another kind of token", async () => {
    const playerId = await optedInPlayer();
    expect(await unsubscribe(db, "nope.nope", ctx())).toBeNull();
    const claimKind = signToken("claim", { v: 1, p: playerId });
    expect(await unsubscribe(db, claimKind, ctx())).toBeNull();
    const player = (await db.players.findOne())!;
    expect(player.marketingOptIn).toBe(true);
  });
});
