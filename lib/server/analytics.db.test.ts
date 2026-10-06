import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { newEvent } from "@/db/schema";
import { connect, resetDb } from "@/tests/db";
import { checkAlerts } from "./alerts";
import { funnel } from "./admin/dashboard";
import { montrealDay, recordServerEvent, rollupEvents } from "./analytics";

const { db, close } = connect();
afterAll(close);
beforeEach(() => resetDb(db));

const ev = (name: string, sessionId: string, props: Record<string, string | number> = {}) =>
  newEvent({
    name,
    sessionId,
    props,
    src: "lapresse",
    lang: "fr",
    device: "mobile",
  });

describe("daily rollup and funnel (AN-02, ADM-02)", () => {
  it("counts events per day and dimension, and is safe to run twice", async () => {
    await db.events.insertMany([
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
    const today = montrealDay();
    await rollupEvents(db, today);
    await rollupEvents(db, today);
    const rows = await funnel(db, today, today, "src");
    expect(rows).toEqual([
      {
        key: "lapresse",
        loads: 2,
        starts: 2,
        reached100m: 1,
        garlic10: 1,
        claimViews: 1,
        claims: 1,
        optIns: 1,
      },
    ]);
    // One row per event, detail and dimension: no repeats after a second run.
    expect(await db.eventsDaily.countDocuments()).toBe(8);
  });

  it("counts a session once per event however many events it sent, and server events as events only", async () => {
    await db.events.insertMany([ev("start", "s1"), ev("start", "s1"), ev("start", "s2")]);
    await recordServerEvent(db, "email_sent", { kind: "coupon" }, { lang: "fr" });
    await rollupEvents(db, montrealDay());
    const start = (await db.eventsDaily.findOne({ name: "start" }))!;
    expect(start).toMatchObject({ events: 3, sessions: 2, detail: "" });
    const sent = (await db.eventsDaily.findOne({ name: "email_sent" }))!;
    expect(sent).toMatchObject({ events: 1, sessions: 0, lang: "fr", src: "", device: "" });
  });

  it("splits by day, newest first, and groups the other splits by volume", async () => {
    await db.events.insertMany([ev("start", "s1"), ev("start", "s2")]);
    await db.events.insertOne(
      newEvent({ name: "start", sessionId: "s3", src: "other", lang: "en", device: "desktop" }),
    );
    await rollupEvents(db, montrealDay());
    const today = montrealDay();
    expect((await funnel(db, today, today, "day")).map((r) => [r.key, r.starts])).toEqual([
      [today, 3],
    ]);
    expect((await funnel(db, today, today, "src")).map((r) => [r.key, r.starts])).toEqual([
      ["lapresse", 2],
      ["other", 1],
    ]);
    expect(await funnel(db, "2000-01-01", "2000-01-02", "day")).toEqual([]);
  });
});

describe("alerts (NFR-08)", () => {
  it("fire when claim errors pass 2% or bounces spike, with enough traffic", async () => {
    const claimsOk = Array.from({ length: 48 }, () =>
      newEvent({ name: "api_claim", props: { outcome: "ok" } }),
    );
    const claimsBad = Array.from({ length: 2 }, () =>
      newEvent({ name: "api_claim", props: { outcome: "error" } }),
    );
    await db.events.insertMany([...claimsOk, ...claimsBad]);
    const sent = Array.from({ length: 30 }, () => newEvent({ name: "email_sent" }));
    await db.events.insertMany([
      ...sent,
      newEvent({ name: "email_bounced", props: { kind: "bounced" } }),
    ]);
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
    await db.events.insertOne(newEvent({ name: "api_claim", props: { outcome: "error" } }));
    expect((await checkAlerts(db)).every((r) => !r.firing)).toBe(true);
  });
});
