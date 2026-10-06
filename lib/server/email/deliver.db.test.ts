import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { BOTH, connect, ctx, finish, resetDb, seedCampaign } from "@/tests/db";
import { claimRewards } from "../claims";
import { deliverEmail, dueEmails, queueResend, retryDelayMs } from "./deliver";
import { SendError, type OutgoingEmail, type Sender } from "./sender";
import { handleEmailEvent } from "./webhook";

const { db, close } = connect();
afterAll(close);
beforeEach(async () => {
  await resetDb(db);
  await seedCampaign(db);
});

function recordingSender(fail?: SendError) {
  const sent: OutgoingEmail[] = [];
  const send: Sender = async (email) => {
    if (fail) throw fail;
    sent.push(email);
    return { id: `re_${sent.length}` };
  };
  return { sent, send };
}

async function claimed(marketingOptIn = false) {
  const run = await finish(db, BOTH());
  const res = await claimRewards(
    db,
    {
      claimToken: run.claimToken!,
      email: "Coupon.Fan@gmail.com",
      lang: "en",
      termsAge: true,
      marketingOptIn,
      src: "lapresse",
      utm: {},
    },
    ctx(),
  );
  if (!res.ok) throw new Error(res.error);
  return res;
}

const outbox = async (id: string) => (await db.emailOutbox.findOne({ _id: id }))!;
const claimIds = async () => (await db.claims.find().toArray()).map((c) => c._id);

describe("coupon email delivery (MAIL-02, MAIL-05, MAIL-07)", () => {
  it("sends one email with every code to the address as typed", async () => {
    const res = await claimed();
    const { sent, send } = recordingSender();
    expect(await deliverEmail(db, res.emailId!, send)).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("Coupon.Fan@gmail.com");
    expect(sent[0].subject).toBe("Your free Coke and garlic sauce are waiting");
    for (const c of res.response.codes) expect(sent[0].text).toContain(c.code);
    expect(sent[0].headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(sent[0].idempotencyKey).toBe(`email-${res.emailId}`);
    expect(await outbox(res.emailId!)).toMatchObject({
      status: "sent",
      providerId: "re_1",
      attempts: 1,
    });
    const rows = await db.claims.find().toArray();
    expect(rows.every((c) => c.emailStatus === "sent")).toBe(true);
    expect(await db.events.find({ name: "email_sent" }).toArray()).toHaveLength(1);
  });

  it("never sends the same row twice, even if called again", async () => {
    const res = await claimed();
    const { sent, send } = recordingSender();
    await Promise.all([deliverEmail(db, res.emailId!, send), deliverEmail(db, res.emailId!, send)]);
    expect(await deliverEmail(db, res.emailId!, send)).toBe("skipped");
    expect(sent).toHaveLength(1);
  });

  it("retries with growing delays, then gives up after 24 hours", async () => {
    const res = await claimed();
    const { send } = recordingSender(new SendError("rate_limit_exceeded", true));
    const t0 = new Date();
    expect(await deliverEmail(db, res.emailId!, send, t0)).toBe("retry");
    let row = await outbox(res.emailId!);
    expect(row.status).toBe("retry");
    expect(row.nextAttemptAt.getTime() - t0.getTime()).toBe(retryDelayMs(1));
    expect(await dueEmails(db, t0)).toEqual([]);
    const t1 = new Date(row.nextAttemptAt.getTime() + 1);
    expect(await dueEmails(db, t1)).toEqual([res.emailId]);
    expect(await deliverEmail(db, res.emailId!, send, t1)).toBe("retry");
    row = await outbox(res.emailId!);
    expect(row.nextAttemptAt.getTime() - t1.getTime()).toBe(retryDelayMs(2));
    expect(retryDelayMs(2)).toBeGreaterThan(retryDelayMs(1));

    const late = new Date(row.createdAt.getTime() + 24 * 3_600_000);
    expect(await deliverEmail(db, res.emailId!, send, late)).toBe("failed");
    expect((await outbox(res.emailId!)).status).toBe("failed");
    expect((await db.claims.findOne())!.emailStatus).toBe("failed");
  });

  it("takes back a row whose sender died, once its lease has run out", async () => {
    const res = await claimed();
    const { sent, send } = recordingSender();
    const t0 = new Date();
    // A sender takes the row and dies before finishing it.
    await db.emailOutbox.updateOne(
      { _id: res.emailId! },
      { $set: { status: "sending", leaseUntil: new Date(t0.getTime() + 60_000) } },
    );
    expect(await dueEmails(db, t0)).toEqual([]);
    expect(await deliverEmail(db, res.emailId!, send, t0)).toBe("skipped");
    const later = new Date(t0.getTime() + 61_000);
    expect(await dueEmails(db, later)).toEqual([res.emailId]);
    expect(await deliverEmail(db, res.emailId!, send, later)).toBe("sent");
    expect(sent).toHaveLength(1);
  });

  it("doesn't retry errors a retry can't fix", async () => {
    const res = await claimed();
    const { send } = recordingSender(new SendError("validation_error: bad to", false));
    expect(await deliverEmail(db, res.emailId!, send)).toBe("failed");
  });

  it("re-sends earlier codes to the stored address (MAIL-08)", async () => {
    const res = await claimed();
    const resendId = await queueResend(db, res.playerId, await claimIds(), "fr", null);
    const { sent, send } = recordingSender();
    expect(await deliverEmail(db, resendId!, send)).toBe("sent");
    expect(sent[0].to).toBe("Coupon.Fan@gmail.com");
    expect(sent[0].subject).toBe("Votre Coke et votre sauce à l'ail gratuits vous attendent");
    expect(sent[0].text).toContain("voici de nouveau vos codes");
  });

  it("adds codes to an email that hasn't gone out yet", async () => {
    const res = await claimed();
    const [first, second] = await claimIds();
    const resendId = await queueResend(db, res.playerId, [first], "fr", null);
    expect(await queueResend(db, res.playerId, [second], "fr", resendId)).toBe(resendId);
    expect((await outbox(resendId!)).claimIds).toEqual([first, second]);
    expect(await queueResend(db, res.playerId, [], "fr", null)).toBeNull();
  });
});

describe("bounce and complaint webhook (MAIL-07)", () => {
  it("a hard bounce blocks every later send", async () => {
    const res = await claimed();
    const { send } = recordingSender();
    await deliverEmail(db, res.emailId!, send);
    await handleEmailEvent(db, {
      type: "email.bounced",
      data: { email_id: "re_1", to: ["coupon.fan@gmail.com"], bounce: { type: "Permanent" } },
    });
    const player = (await db.players.findOne())!;
    expect(player.emailBlockReason).toBe("bounced");

    const resendId = await queueResend(db, res.playerId, await claimIds(), "en", null);
    const second = recordingSender();
    expect(await deliverEmail(db, resendId!, second.send)).toBe("blocked");
    expect(second.sent).toHaveLength(0);
    expect(await db.events.find({ name: "email_bounced" }).toArray()).toHaveLength(1);
  });

  it("ignores soft bounces", async () => {
    await claimed();
    await handleEmailEvent(db, {
      type: "email.bounced",
      data: { to: ["coupon.fan@gmail.com"], bounce: { type: "Transient" } },
    });
    expect((await db.players.findOne())!.emailBlockedAt).toBeNull();
  });

  it("a complaint also withdraws marketing consent (CASL)", async () => {
    await claimed(true);
    await handleEmailEvent(db, { type: "email.complained", data: { to: ["CouponFan@gmail.com"] } });
    const player = (await db.players.findOne())!;
    expect(player).toMatchObject({ marketingOptIn: false, emailBlockReason: "complained" });
    const last = (await db.consents.find().sort({ _id: 1 }).toArray()).at(-1);
    expect(last).toMatchObject({ kind: "marketing", granted: false, source: "complaint" });
  });
});
