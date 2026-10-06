import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { consents, crmOutbox, players } from "@/db/schema";
import { BOTH, connect, ctx, finish, resetDb, seedCampaign } from "@/tests/db";
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

describe("consent log is append-only (DATA-03)", () => {
  it("refuses UPDATE and DELETE", async () => {
    await optedInPlayer();
    // Drizzle wraps the driver error; the trigger's message is on its cause.
    const refused = {
      cause: expect.objectContaining({ message: expect.stringMatching(/append-only/) }),
    };
    await expect(db.update(consents).set({ granted: false })).rejects.toMatchObject(refused);
    await expect(db.delete(consents)).rejects.toMatchObject(refused);
    await expect(db.execute(sql`truncate consents cascade`)).rejects.toMatchObject(refused);
    expect(await db.select().from(consents)).toHaveLength(2);
  });

  it("lets the retention job delete when it says so", async () => {
    await optedInPlayer();
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local boustan.allow_consent_purge = 'on'`);
      await tx.delete(consents);
    });
    expect(await db.select().from(consents)).toHaveLength(0);
  });
});

describe("unsubscribe link (DATA-07, AC-07)", () => {
  it("logs a withdrawal, turns marketing off and queues it for the CRM", async () => {
    const playerId = await optedInPlayer();
    const token = signToken("unsubscribe", { v: 1, p: playerId });
    expect(await unsubscribe(db, token, ctx())).toEqual({ lang: "fr" });

    const [player] = await db.select().from(players).where(eq(players.id, playerId));
    expect(player.marketingOptIn).toBe(false);
    const rows = await db.select().from(consents).orderBy(consents.id);
    expect(rows.at(-1)).toMatchObject({
      kind: "marketing",
      granted: false,
      source: "unsubscribe",
      language: "fr",
      ip: "203.0.113.7",
      text: "Désabonnement des offres et nouvelles de Boustan par courriel.",
    });
    const crm = await db.select().from(crmOutbox).where(eq(crmOutbox.type, "consent_changed"));
    expect(crm.map((c) => c.payload.marketing)).toEqual([true, false]);
  });

  it("ignores links that are forged or for another kind of token", async () => {
    const playerId = await optedInPlayer();
    expect(await unsubscribe(db, "nope.nope", ctx())).toBeNull();
    const claimKind = signToken("claim", { v: 1, p: playerId });
    expect(await unsubscribe(db, claimKind, ctx())).toBeNull();
    const [player] = await db.select().from(players);
    expect(player.marketingOptIn).toBe(true);
  });
});
