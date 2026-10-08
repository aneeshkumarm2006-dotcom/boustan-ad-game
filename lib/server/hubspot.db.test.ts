import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { newCrmOutbox, newPlayer } from "@/db/schema";
import { connect, resetDb } from "@/tests/db";
import { resetEnvForTests } from "./env";
import { deliverHubspotSignups } from "./hubspot";
import { saveScore } from "./scores";

const { db, close } = connect();
afterAll(close);
const send = vi.fn<typeof fetch>();
beforeEach(async () => {
  await resetDb(db);
  vi.stubEnv("HUBSPOT_SIGNUP_WEBHOOK_URL", "https://example.com/hubspot");
  resetEnvForTests();
  vi.stubGlobal("fetch", send);
  send.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetEnvForTests();
});

async function register() {
  return saveScore(
    db,
    {
      saveToken: "",
      email: "Person@example.com",
      nickname: "Sam",
      lang: "en",
      termsAge: true,
      marketingOptIn: false,
      src: null,
      utm: {},
    },
    { ip: null, userAgent: null, now: new Date() },
    true,
  );
}

it("sends a new signup's email and name once, including without marketing opt-in", async () => {
  await register();
  await register();
  expect(await deliverHubspotSignups(db)).toBe(1);
  expect(await deliverHubspotSignups(db)).toBe(0);
  expect(send).toHaveBeenCalledTimes(1);
  const [url, options] = send.mock.calls[0];
  expect(url).toBe("https://example.com/hubspot");
  expect(options?.method).toBe("POST");
  expect(JSON.parse(options?.body as string)).toMatchObject({
    email: "person@example.com",
    name: "Sam",
    marketingOptIn: false,
  });
  expect(await db.players.findOne({ nickname: "Sam" })).toMatchObject({ crmStatus: "synced" });
});

it.each(["http", "network"])("retains failed %s delivery for retry", async (failure) => {
  await register();
  if (failure === "http") send.mockResolvedValueOnce(new Response(null, { status: 503 }));
  else send.mockRejectedValueOnce(new Error("private details"));
  expect(await deliverHubspotSignups(db)).toBe(0);
  const row = await db.crmOutbox.findOne({ type: "contact_upsert" });
  expect(row).toMatchObject({
    status: "pending",
    attempts: 1,
    lastError: failure === "http" ? "http_503" : "network_error",
  });
  expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  await db.crmOutbox.updateOne({ _id: row!._id }, { $set: { nextAttemptAt: new Date(0) } });
  expect(await deliverHubspotSignups(db)).toBe(1);
});

it("leases events so concurrent workers cannot both send them", async () => {
  await register();
  await Promise.all([deliverHubspotSignups(db), deliverHubspotSignups(db)]);
  expect(send).toHaveBeenCalledTimes(1);
});

it("skips deleted players and does not send historical events", async () => {
  await register();
  await db.players.updateMany({}, { $set: { deletedAt: new Date() } });
  const old = newPlayer({
    email: "old@example.com",
    emailNormalized: "old@example.com",
    language: "en",
  });
  await db.players.insertOne(old);
  await db.crmOutbox.insertOne(
    newCrmOutbox({
      playerId: old._id,
      type: "contact_upsert",
      payload: { created: true },
      idempotencyKey: "old",
    }),
  );
  expect(await deliverHubspotSignups(db)).toBe(0);
  expect(send).not.toHaveBeenCalled();
  expect(await db.crmOutbox.countDocuments({ status: "skipped" })).toBe(1);
});

it("does not send when disabled", async () => {
  vi.stubEnv("HUBSPOT_SIGNUP_WEBHOOK_URL", "");
  resetEnvForTests();
  await register();
  expect(await deliverHubspotSignups(db)).toBe(0);
  expect(send).not.toHaveBeenCalled();
});
