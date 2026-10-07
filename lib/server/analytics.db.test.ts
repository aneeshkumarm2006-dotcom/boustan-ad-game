import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { newEvent } from "@/db/schema";
import { connect, resetDb } from "@/tests/db";
import { ALERTS, checkAlerts } from "./alerts";
import { montrealDay, recordServerEvent, rollupEvents } from "./analytics";

// An alert becomes a Sentry event; none of it should leave the test.
const sentry = vi.hoisted(() => ({
  captureMessage: vi.fn(async () => {}),
  captureException: vi.fn(async () => {}),
}));
vi.mock("./sentry", () => sentry);

const { db, close } = connect();
afterAll(close);
beforeEach(async () => {
  await resetDb(db);
  sentry.captureMessage.mockClear();
});

const ev = (
  name: string,
  sessionId: string,
  props: Record<string, string | number | boolean> = {},
) => newEvent({ name, sessionId, props, src: "lapresse", lang: "fr", device: "mobile" });

const detailsByEvent = async () =>
  Object.fromEntries((await db.eventsDaily.find().toArray()).map((r) => [r.name, r.detail]));

describe("server events (AN-01)", () => {
  it("stores a server event with its placement, language and device, and no session", async () => {
    await recordServerEvent(
      db,
      "api_save",
      { outcome: "ok" },
      { src: "lapresse", lang: "fr", device: "mobile", hostOrigin: "https://news.example" },
    );
    expect(await db.events.findOne()).toMatchObject({
      name: "api_save",
      props: { outcome: "ok" },
      src: "lapresse",
      lang: "fr",
      device: "mobile",
      hostOrigin: "https://news.example",
      sessionId: null,
    });
  });

  it("stores nothing but the name when that is all there is", async () => {
    await recordServerEvent(db, "opt_in");
    expect(await db.events.findOne()).toMatchObject({
      name: "opt_in",
      props: {},
      src: null,
      lang: null,
      device: null,
      hostOrigin: null,
    });
  });
});

describe("daily rollup (AN-02)", () => {
  it("counts events per day, event and dimension, and is safe to run twice", async () => {
    await db.events.insertMany([
      ev("load", "s1"),
      ev("load", "s2"),
      ev("start", "s1"),
      ev("start", "s1"),
      ev("milestone", "s1", { points: 100 }),
      ev("milestone", "s2", { points: 100 }),
      ev("milestone", "s1", { points: 50 }),
      ev("game_over", "s1"),
      ev("save_view", "s1"),
      ev("save_success", "s1"),
    ]);
    await recordServerEvent(db, "opt_in", {}, { src: "lapresse", lang: "fr", device: "mobile" });
    const today = montrealDay();
    expect(await rollupEvents(db, today)).toBe(8);
    expect(await rollupEvents(db, today)).toBe(8);

    const rows = await db.eventsDaily.find().toArray();
    // One row per event, detail and dimension: no repeats after a second run.
    expect(rows).toHaveLength(8);
    const row = (name: string, detail = "") =>
      rows.find((r) => r.name === name && r.detail === detail);
    expect(row("load")).toMatchObject({
      day: today,
      src: "lapresse",
      lang: "fr",
      device: "mobile",
      events: 2,
      sessions: 2,
    });
    expect(row("start")).toMatchObject({ events: 2, sessions: 1 });
    expect(row("milestone", "100")).toMatchObject({ events: 2, sessions: 2 });
    expect(row("milestone", "50")).toMatchObject({ events: 1, sessions: 1 });
    for (const name of ["game_over", "save_view", "save_success"]) {
      expect(row(name), name).toMatchObject({ events: 1, sessions: 1 });
    }
  });

  it("counts a session once per event however many it sent, and a server event as an event only", async () => {
    await db.events.insertMany([ev("start", "s1"), ev("start", "s1"), ev("start", "s2")]);
    await recordServerEvent(db, "api_save", { outcome: "ok" }, { lang: "fr" });
    await rollupEvents(db, montrealDay());
    expect(await db.eventsDaily.findOne({ name: "start" })).toMatchObject({
      events: 3,
      sessions: 2,
      detail: "",
    });
    expect(await db.eventsDaily.findOne({ name: "api_save" })).toMatchObject({
      events: 1,
      sessions: 0,
      detail: "ok",
      lang: "fr",
      src: "",
      device: "",
    });
  });

  it("splits each event by the one prop that tells its cases apart", async () => {
    await db.events.insertMany([
      ev("milestone", "s1", { points: 150 }),
      ev("cta_click", "s1", { target: "order" }),
      ev("save_error", "s1", { reason: "network" }),
      // No split for this one, whatever it carries.
      ev("start", "s1", { online: true }),
    ]);
    await recordServerEvent(db, "api_save", { outcome: "closed" });
    await rollupEvents(db, montrealDay());
    expect(await detailsByEvent()).toEqual({
      milestone: "150",
      cta_click: "order",
      save_error: "network",
      start: "",
      api_save: "closed",
    });
  });

  it("keeps a number or a boolean prop as its text, and a missing one as blank", async () => {
    await db.events.insertMany([
      ev("save_error", "s1", { reason: true }),
      ev("milestone", "s1"),
      ev("cta_click", "s1", { target: 12 }),
    ]);
    await rollupEvents(db, montrealDay());
    const rows = await db.eventsDaily.find().toArray();
    expect(rows.map((r) => [r.name, r.detail]).sort()).toEqual([
      ["cta_click", "12"],
      ["milestone", ""],
      ["save_error", "true"],
    ]);
  });

  it("recounts instead of adding, so a late or repeated run changes nothing it shouldn't", async () => {
    await db.events.insertMany([ev("load", "s1"), ev("load", "s2")]);
    await rollupEvents(db, montrealDay());
    expect(await db.eventsDaily.findOne({ name: "load" })).toMatchObject({
      events: 2,
      sessions: 2,
    });
    await db.events.insertOne(ev("load", "s3"));
    await rollupEvents(db, montrealDay());
    expect(await db.eventsDaily.countDocuments({ name: "load" })).toBe(1);
    expect(await db.eventsDaily.findOne({ name: "load" })).toMatchObject({
      events: 3,
      sessions: 3,
    });
  });

  it("splits by the Montréal day an event happened on, in winter and in summer", async () => {
    const at = (iso: string) =>
      newEvent({ name: "load", sessionId: iso, createdAt: new Date(iso) });
    await db.events.insertMany([
      at("2026-01-15T04:59:59Z"), // 23:59:59 on Jan 14 in Montréal (UTC-5)
      at("2026-01-15T05:00:00Z"), // midnight
      at("2026-07-15T03:59:59Z"), // 23:59:59 on Jul 14 (UTC-4)
      at("2026-07-15T04:00:00Z"), // midnight
    ]);
    expect(await rollupEvents(db, "2026-01-14")).toBe(4);
    const rows = await db.eventsDaily.find().sort({ day: 1 }).toArray();
    expect(rows.map((r) => [r.day, r.events])).toEqual([
      ["2026-01-14", 1],
      ["2026-01-15", 1],
      ["2026-07-14", 1],
      ["2026-07-15", 1],
    ]);
  });

  it("only recounts from the day it is given, and leaves the older rows alone", async () => {
    await db.events.insertMany([
      newEvent({ name: "load", sessionId: "old", createdAt: new Date("2026-01-10T17:00:00Z") }),
      newEvent({ name: "load", sessionId: "new", createdAt: new Date("2026-01-12T17:00:00Z") }),
    ]);
    expect(await rollupEvents(db, "2026-01-12")).toBe(1);
    expect((await db.eventsDaily.find().toArray()).map((r) => r.day)).toEqual(["2026-01-12"]);
  });

  it("does nothing, and says so, when there are no events", async () => {
    expect(await rollupEvents(db, montrealDay())).toBe(0);
    expect(await db.eventsDaily.countDocuments()).toBe(0);
  });
});

describe("alerts (NFR-08)", () => {
  const saves = (outcome: string, n: number, createdAt = new Date()) =>
    Array.from({ length: n }, () => newEvent({ name: "api_save", props: { outcome }, createdAt }));

  it("asks for at least 20 saves in the last hour and more than 2% server errors", () => {
    expect(ALERTS.saveErrorRate).toEqual({ threshold: 0.02, minSample: 20, windowMs: 3_600_000 });
  });

  it("fires when server errors pass 2% of the last hour's saves, with enough of them", async () => {
    await db.events.insertMany([...saves("ok", 48), ...saves("error", 2)]);
    expect(await checkAlerts(db)).toEqual([
      { name: "saveErrorRate", rate: 0.04, sample: 50, firing: true },
    ]);
    expect(sentry.captureMessage).toHaveBeenCalledWith("Alert: saveErrorRate at 4.0%", {
      tags: { alert: "saveErrorRate", sample: 50 },
      fingerprint: ["boustan-alert", "saveErrorRate"],
    });
  });

  it("stays quiet at exactly 2%, and on a small sample", async () => {
    await db.events.insertMany([...saves("ok", 49), ...saves("error", 1)]);
    expect(await checkAlerts(db)).toMatchObject([{ rate: 0.02, sample: 50, firing: false }]);

    await resetDb(db);
    await db.events.insertMany(saves("error", 10));
    expect(await checkAlerts(db)).toMatchObject([{ rate: 1, sample: 10, firing: false }]);
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("counts only a refused save as the player's doing: closed, expired and bad email aren't errors", async () => {
    await db.events.insertMany([
      ...saves("ok", 20),
      ...saves("closed", 10),
      ...saves("expired", 10),
      ...saves("rejected", 10),
      ...saves("bad_email", 10),
    ]);
    expect(await checkAlerts(db)).toMatchObject([{ rate: 0, sample: 60, firing: false }]);
  });

  it("looks only at the last hour", async () => {
    const now = new Date("2026-10-15T15:00:00Z");
    const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
    await db.events.insertMany([
      ...saves("error", 30, minutesAgo(61)),
      ...saves("ok", 20, minutesAgo(59)),
      ...saves("error", 1, minutesAgo(59)),
    ]);
    expect(await checkAlerts(db, now)).toMatchObject([{ sample: 21, firing: true }]);
    // An hour later, none of those saves count any more.
    expect(await checkAlerts(db, new Date(now.getTime() + 2 * 3_600_000))).toMatchObject([
      { rate: 0, sample: 0, firing: false },
    ]);
  });

  it("ignores events that only look like a save", async () => {
    await db.events.insertMany([
      ...saves("ok", 20),
      ...Array.from({ length: 20 }, () =>
        newEvent({ name: "save_error", props: { outcome: "error" } }),
      ),
    ]);
    expect(await checkAlerts(db)).toMatchObject([{ rate: 0, sample: 20, firing: false }]);
  });
});
