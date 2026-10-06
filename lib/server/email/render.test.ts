import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { emailViewTokenSchema, unsubscribeTokenSchema, verifyToken } from "../tokens";
import { renderCouponEmail } from "./render";

const base = {
  emailId: randomUUID(),
  playerId: randomUUID(),
  resend: false,
  src: "lapresse",
  codes: [
    { reward: "free_coke" as const, code: "BST-7K2M-9QX4", expiresAt: "2026-11-15T12:00:00.000Z" },
    {
      reward: "free_garlic_sauce" as const,
      code: "BST-A3VD-ZP8R",
      expiresAt: "2026-11-15T12:00:00.000Z",
    },
  ],
};

describe("coupon email (MAIL-03 to MAIL-06)", () => {
  it("puts every code in one French email, readable as plain text", async () => {
    const email = await renderCouponEmail({ ...base, lang: "fr" });
    expect(email.subject).toBe("Votre Coke et votre sauce à l'ail gratuits vous attendent");
    for (const c of base.codes) {
      expect(email.html).toContain(c.code);
      expect(email.text).toContain(c.code);
    }
    expect(email.text).toContain("Expire le 15 nov. 2026");
    expect(email.html).toContain('lang="fr"');
    expect(email.html).not.toMatch(/<img/i);
  });

  it("uses the player's language, with a link to the other one", async () => {
    const email = await renderCouponEmail({ ...base, lang: "en", codes: base.codes.slice(0, 1) });
    expect(email.subject).toBe("Your free Coke is waiting");
    expect(email.text).toContain("Expires Nov 15, 2026");
    const view = /https:\/\/game\.test\/api\/email\/view\?t=([\w.-]+)&amp;lang=fr/.exec(email.html);
    expect(view).not.toBeNull();
    expect(verifyToken("email_view", view![1], emailViewTokenSchema)?.e).toBe(base.emailId);
  });

  it("has UTM-tagged buttons, play again, and a signed unsubscribe link (MAIL-04)", async () => {
    const email = await renderCouponEmail({ ...base, lang: "en" });
    expect(email.html).toContain("utm_medium=email");
    expect(email.html).toContain("utm_content=lapresse");
    expect(email.html).toContain("https://game.test/?lang=en&amp;src=email");
    const token = new URL(email.unsubscribeUrl).searchParams.get("t")!;
    expect(verifyToken("unsubscribe", token, unsubscribeTokenSchema)?.p).toBe(base.playerId);
    expect(email.text).toContain("Unsubscribe from offers");
  });
});
