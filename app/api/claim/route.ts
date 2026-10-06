import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { z } from "zod";
import { recordServerEvent } from "@/lib/server/analytics";
import { claimRewards, type ClaimError } from "@/lib/server/claims";
import { db } from "@/lib/server/db";
import { deliverEmail, queueResend } from "@/lib/server/email/deliver";
import {
  apiError,
  json,
  langSchema,
  readBody,
  requestContext,
  srcSchema,
  tooMany,
  utmSchema,
  withErrors,
} from "@/lib/server/http";
import { log } from "@/lib/server/log";
import { rateLimit } from "@/lib/server/rate-limit";
import { emailKey, hashToken } from "@/lib/server/tokens";
import { verifyTurnstile } from "@/lib/server/turnstile";

const body = z.object({
  claimToken: z.string().min(1).max(2048),
  email: z.string().max(320).optional(),
  playerToken: z.string().max(200).optional(),
  nickname: z.string().max(64).optional(),
  lang: langSchema,
  termsAge: z.boolean(),
  marketingOptIn: z.boolean(),
  turnstileToken: z.string().max(4096).default(""),
  src: srcSchema,
  utm: utmSchema,
});

const ERROR_STATUS: Record<ClaimError, number> = {
  expired: 410,
  rejected: 400,
  bad_email: 400,
  unknown_player: 400,
};

/**
 * POST /api/claim → {codes[], alreadyClaimed[], unavailable[], playerToken, rank}. Also "Save my
 * score" when the run unlocked nothing (§15.3). The coupon email goes out after the response
 * (MAIL-02).
 */
export const POST = withErrors("claim", async (request: Request) => {
  const ctx = requestContext(request);
  const now = new Date();
  const ipLimit = await rateLimit("claimIp", ctx.ip ?? "unknown");
  if (!ipLimit.ok) return tooMany(ipLimit.retryAfterS);
  const parsed = await readBody(request, body);
  if (!parsed.ok) return parsed.response;
  const input = parsed.data;

  // One-tap claims carry the device token; the form (and "Not you?") carries an email.
  const playerToken = input.email ? undefined : (input.playerToken ?? ctx.playerToken ?? undefined);
  if (playerToken) {
    const tokenLimit = await rateLimit("claimPlayer", hashToken(playerToken));
    if (!tokenLimit.ok) return tooMany(tokenLimit.retryAfterS);
  }

  const human = await verifyTurnstile(input.turnstileToken, ctx.ip, randomUUID());
  if (human === "unavailable") return apiError(503, "unavailable");
  if (human === "failed") return apiError(400, "rejected");

  const event = (outcome: string) => () =>
    recordServerEvent(
      db(),
      "api_claim",
      { outcome },
      { src: input.src, lang: input.lang, device: ctx.device },
    );

  let result;
  try {
    result = await claimRewards(
      db(),
      { ...input, playerToken },
      { ip: ctx.ip, userAgent: ctx.userAgent, now },
    );
  } catch (error) {
    after(event("error"));
    throw error;
  }
  if (!result.ok) {
    after(event(result.error));
    return apiError(ERROR_STATUS[result.error], result.error);
  }

  // "Already claimed": re-send the original codes, within the resend limit (§3.4, MAIL-08).
  let emailId = result.emailId;
  if (result.alreadyClaimIds.length > 0) {
    const limit = await rateLimit("resendEmail", emailKey(result.emailNormalized));
    if (limit.ok) {
      emailId = await queueResend(
        db(),
        result.playerId,
        result.alreadyClaimIds,
        input.lang,
        emailId,
      );
    }
  }

  const { response, optedIn } = result;
  after(async () => {
    if (emailId) {
      await deliverEmail(db(), emailId).catch((error) =>
        log.error("email_after_failed", error, { emailId }),
      );
    }
    await event("ok")();
    if (optedIn) {
      await recordServerEvent(
        db(),
        "opt_in",
        {},
        { src: input.src, lang: input.lang, device: ctx.device },
      );
    }
  });
  log.info("claim_ok", {
    issued: response.codes.length,
    already: response.alreadyClaimed.length,
    unavailable: response.unavailable.length,
  });
  return json(response);
});
