import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { events } from "@/db/schema";
import { connect, resetDb } from "@/tests/db";
import { checkAlerts } from "./alerts";
import { recordServerEvent, rollupEvents } from "./analytics";

const { db, close } = connect();
afterAll(close);
beforeEach(() => resetDb(db));

const ev = (name: string, sessionId: string, props: Record<string, string | number> = {}) => ({
  name,
  sessionId,
  props,
  src: "lapresse",
  lang: "fr",
  device: "mobile",
});

describe("daily rollup and funnel view (AN-02, ADM-02)", () => {
  it("counts events per day and dimension, and is safe to run twice", async () => {
    await db
      .insert(events)
      .values([
        ev("load", "s1"),
        ev("load", "s2"),
        ev("start", "s1"),
        ev("start", "s1"),
        ev("milestone", "s1", { m: 100 }),
        ev("milestone", "s1", { m: 50 }),
        ev("reward_unlocked", "s1", { reward: "free_garlic_sauce" }),
        ev("claim_view", "s1"),
        ev("claim_success", "s1"),
      ]);
    await recordServerEvent(db, "opt_in", {}, { src: "lapresse", lang: "fr", device: "mobile" });
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(
      new Date(),
    );
    await rollupEvents(db, today);
    await rollupEvents(db, today);
    const funnel = await db.execute<Record<string, unknown>>(
      sql`select loads::int, starts::int, reached_100m::int, garlic_10::int, claim_views::int,
                 claims::int, opt_ins::int
          from v_funnel_daily where src = 'lapresse' and lang = 'fr' and device = 'mobile'`,
    );
    expect(funnel[0]).toEqual({
      loads: 2,
      starts: 2,
      reached_100m: 1,
      garlic_10: 1,
      claim_views: 1,
      claims: 1,
      opt_ins: 1,
    });
  });
});

describe("alerts (NFR-08)", () => {
  it("fire when claim errors pass 2% or bounces spike, with enough traffic", async () => {
    const claimsOk = Array.from({ length: 48 }, () => ({
      name: "api_claim",
      props: { outcome: "ok" },
    }));
    const claimsBad = Array.from({ length: 2 }, () => ({
      name: "api_claim",
      props: { outcome: "error" },
    }));
    await db.insert(events).values([...claimsOk, ...claimsBad]);
    const sent = Array.from({ length: 30 }, () => ({ name: "email_sent", props: {} }));
    await db
      .insert(events)
      .values([...sent, { name: "email_bounced", props: { kind: "bounced" } }]);
    const results = await checkAlerts(db);
    expect(results.find((r) => r.name === "claimErrorRate")).toMatchObject({
      firing: true,
      sample: 50,
    });
    expect(results.find((r) => r.name === "bounceRate")).toMatchObject({
      firing: false,
      sample: 30,
    });
  });

  it("stay quiet on tiny samples", async () => {
    await db.insert(events).values({ name: "api_claim", props: { outcome: "error" } });
    expect((await checkAlerts(db)).every((r) => !r.firing)).toBe(true);
  });
});
