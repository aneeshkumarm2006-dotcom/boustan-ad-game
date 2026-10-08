import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { z } from "zod";
import { recordServerEvent } from "@/lib/server/analytics";
import { db } from "@/lib/server/db";
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
import { saveScore, type SaveError } from "@/lib/server/scores";
import { verifyTurnstile } from "@/lib/server/turnstile";

const body = z.object({
  email: z.string().max(320),
  nickname: z.string().max(64).optional(),
  lang: langSchema,
  termsAge: z.boolean(),
  marketingOptIn: z.boolean(),
  turnstileToken: z.string().max(4096).default(""),
  src: srcSchema,
  utm: utmSchema,
});

const ERROR_STATUS: Record<SaveError, number> = {
  expired: 410,
  rejected: 400,
  bad_email: 400,
  closed: 409,
};

/** Register a player before play; the normalized email uniquely identifies the entry. */
export const POST = withErrors("register_player", async (request: Request) => {
  const ctx = requestContext(request);
  const now = new Date();
  const ipLimit = await rateLimit("saveIp", ctx.ip ?? "unknown");
  if (!ipLimit.ok) return tooMany(ipLimit.retryAfterS);
  const parsed = await readBody(request, body);
  if (!parsed.ok) return parsed.response;
  const input = parsed.data;

  const human = await verifyTurnstile(input.turnstileToken, ctx.ip, randomUUID());
  if (human === "unavailable") return apiError(503, "unavailable");
  if (human === "failed") return apiError(400, "rejected");

  const result = await saveScore(
    db(),
    { ...input, saveToken: "" },
    { ip: ctx.ip, userAgent: ctx.userAgent, now },
    true,
  );
  if (!result.ok) return apiError(ERROR_STATUS[result.error], result.error);

  const { response, optedIn } = result;
  after(async () => {
    if (optedIn) {
      await recordServerEvent(
        db(),
        "opt_in",
        {},
        { src: input.src, lang: input.lang, device: ctx.device },
      );
    }
  });
  log.info("player_registered", {});
  return json(response);
});
