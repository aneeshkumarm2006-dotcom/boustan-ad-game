import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { after } from "next/server";
import { z } from "zod";
import { claims, players } from "@/db/schema";
import { db } from "@/lib/server/db";
import { deliverEmail, queueResend } from "@/lib/server/email/deliver";
import { checkEmail } from "@/lib/server/email-address";
import { readBody, requestContext, tooMany, withErrors } from "@/lib/server/http";
import { log } from "@/lib/server/log";
import { findPlayerByToken } from "@/lib/server/players";
import { rateLimit } from "@/lib/server/rate-limit";
import { emailKey } from "@/lib/server/tokens";

const body = z.object({ email: z.string().max(320).optional() });

const accepted = () =>
  new Response(null, { status: 202, headers: { "cache-control": "no-store" } });

/**
 * POST /api/claim/resend (MAIL-08): re-sends a player's codes to the address on file, never to
 * a new one. Always 202, whether or not the address is known; 3 per email per hour.
 */
export const POST = withErrors("claim_resend", async (request: Request) => {
  const ctx = requestContext(request);
  const ipLimit = await rateLimit("resendIp", ctx.ip ?? "unknown");
  if (!ipLimit.ok) return tooMany(ipLimit.retryAfterS);
  const parsed = await readBody(request, body, 1024);
  if (!parsed.ok) return parsed.response;

  const q = db();
  let player: typeof players.$inferSelect | null = null;
  if (parsed.data.email) {
    const check = checkEmail(parsed.data.email);
    if (!check.ok) return accepted();
    // Count the attempt before looking the address up, so known and unknown addresses match.
    if (!(await rateLimit("resendEmail", emailKey(check.normalized))).ok) return accepted();
    [player] = await q
      .select()
      .from(players)
      .where(and(eq(players.emailNormalized, check.normalized), isNull(players.deletedAt)));
  } else {
    player = await findPlayerByToken(q, ctx.playerToken);
    if (player && !(await rateLimit("resendEmail", emailKey(player.emailNormalized))).ok) {
      return accepted();
    }
  }
  if (!player || player.emailBlockedAt) return accepted();

  const owned = await q
    .select({ id: claims.id })
    .from(claims)
    .where(and(eq(claims.playerId, player.id), isNotNull(claims.codeId)));
  if (owned.length === 0) return accepted();

  const emailId = await queueResend(
    q,
    player.id,
    owned.map((c) => c.id),
    player.language,
    null,
  );
  after(() =>
    deliverEmail(db(), emailId!).catch((error) =>
      log.error("email_after_failed", error, { emailId }),
    ),
  );
  return accepted();
});
