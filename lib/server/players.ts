/**
 * Players are an email plus device tokens, no accounts (DATA-01). The token lives in the
 * iframe's localStorage and arrives in the X-Player-Token header; only its hash is stored.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Queryable } from "@/db/client";
import { playerTokens, players } from "@/db/schema";
import { hashToken, newPlayerToken } from "./tokens";

export type Player = typeof players.$inferSelect;

/** The live player a device token belongs to, or null. */
export async function findPlayerByToken(q: Queryable, token: string | null | undefined) {
  if (!token || token.length > 200) return null;
  const [row] = await q
    .select({ player: players })
    .from(playerTokens)
    .innerJoin(players, eq(players.id, playerTokens.playerId))
    .where(and(eq(playerTokens.tokenHash, hashToken(token)), isNull(players.deletedAt)));
  return row?.player ?? null;
}

export async function issuePlayerToken(q: Queryable, playerId: string): Promise<string> {
  const token = newPlayerToken();
  await q.insert(playerTokens).values({ tokenHash: hashToken(token), playerId });
  return token;
}

export async function touchPlayerToken(q: Queryable, token: string): Promise<void> {
  await q
    .update(playerTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(playerTokens.tokenHash, hashToken(token)));
}
