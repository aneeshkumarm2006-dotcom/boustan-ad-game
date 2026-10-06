/**
 * Players are an email plus device tokens, no accounts (DATA-01). The token lives in the
 * iframe's localStorage and arrives in the X-Player-Token header; only its hash is stored.
 */
import type { Queryable } from "@/db/client";
import { newPlayerToken as tokenDoc, type PlayerDoc } from "@/db/schema";
import { hashToken, newPlayerToken } from "./tokens";

export type Player = PlayerDoc;

/** The live player a device token belongs to, or null. */
export async function findPlayerByToken(
  q: Queryable,
  token: string | null | undefined,
): Promise<Player | null> {
  if (!token || token.length > 200) return null;
  const device = await q.playerTokens.findOne({ _id: hashToken(token) });
  if (!device) return null;
  return q.players.findOne({ _id: device.playerId, deletedAt: null });
}

export async function issuePlayerToken(q: Queryable, playerId: string): Promise<string> {
  const token = newPlayerToken();
  await q.playerTokens.insertOne(tokenDoc({ _id: hashToken(token), playerId }));
  return token;
}

export async function touchPlayerToken(q: Queryable, token: string): Promise<void> {
  await q.playerTokens.updateOne({ _id: hashToken(token) }, { $set: { lastUsedAt: new Date() } });
}
