import { db } from "@/lib/server/db";
import { apiError, json, requestContext, tooMany, withErrors } from "@/lib/server/http";
import {
  BOARD_DEFAULT_LIMIT,
  BOARD_MAX_LIMIT,
  cachedTop,
  entryOfPlayer,
} from "@/lib/server/leaderboard";
import { findPlayerByToken } from "@/lib/server/players";
import { rateLimit } from "@/lib/server/rate-limit";

/**
 * GET /api/leaderboard?limit=10 → {top[], me?} (LB-04). The top list may be up to 30 s old
 * (LB-08); the caller's own row, found by the X-Player-Token header, is computed fresh. No
 * emails, only nicknames (LB-05).
 */
export const GET = withErrors("leaderboard", async (request: Request) => {
  const ctx = requestContext(request);
  const limit = await rateLimit("leaderboard", ctx.ip ?? "unknown");
  if (!limit.ok) return tooMany(limit.retryAfterS);

  const raw = new URL(request.url).searchParams.get("limit");
  const n = raw === null ? BOARD_DEFAULT_LIMIT : Number(raw);
  if (!Number.isInteger(n) || n < 1) return apiError(400, "bad_request");
  const size = Math.min(n, BOARD_MAX_LIMIT);

  const player = await findPlayerByToken(db(), ctx.playerToken);
  const [top, me] = await Promise.all([
    cachedTop(db(), size),
    player ? entryOfPlayer(db(), player.id) : null,
  ]);
  return json(me ? { top, me } : { top });
});
