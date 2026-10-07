/**
 * Run start and finish (SEC-01 to SEC-04). Starting a run writes nothing: the token carries
 * everything finish needs. Finish writes the run row once, keyed by the run id, so a token
 * can't be spent twice; then it validates the numbers against the seed (game-core) and scores
 * the run on the server: 1 point per metre of the speed curve at `activeMs`, plus 10 per garlic.
 */
import { randomInt, randomUUID } from "node:crypto";
import { insertOnce, isDuplicateKey, type Db } from "@/db/client";
import { newRun } from "@/db/schema";
import { TUNING, distanceMAt, scoreOf, validateRun, type RunFlag } from "@/game-core";
import type { Lang } from "@/i18n";
import type { FinishRunResponse, StartRunResponse } from "@/lib/api/types";
import type { Utm } from "@/lib/session";
import { boardOpen, cachedCampaign, campaignState } from "./campaign";
import { bestOf, rankOfPlayer, rankPreview, updateBestRun } from "./leaderboard";
import { log } from "./log";
import { findPlayerByToken, touchPlayerToken } from "./players";
import { saveTokenSchema, runTokenSchema, signToken, verifyToken } from "./tokens";

/** A score can be saved for this long after the run (SEC-04). */
export const SAVE_WINDOW_MS = 30 * 60 * 1000;

export interface StartInput {
  src: string | null;
  lang: Lang;
  utm: Utm;
  host: string | null;
}

export async function startRun(input: StartInput, now = new Date()): Promise<StartRunResponse> {
  const campaign = await cachedCampaign();
  const runId = randomUUID();
  const seed = randomInt(0, 0x1_0000_0000);
  const token = signToken("run", {
    v: 1,
    id: runId,
    seed,
    iat: now.getTime(),
    tv: TUNING.version,
    lang: input.lang,
    src: input.src,
    host: input.host,
    utm: input.utm,
  });
  return { runId, seed, token, campaign: campaignState(campaign, now) };
}

export interface FinishInput {
  token: string;
  distance: number;
  garlic: number;
  hits: number;
  activeMs: number;
}

export interface FinishContext {
  playerToken: string | null;
  clientVersion: string | null;
  now: Date;
}

/** Same answer for every failure, so a forger learns nothing (SEC-03). */
const INVALID: FinishRunResponse = {
  valid: false,
  points: 0,
  saveToken: null,
  best: null,
  rankPreview: null,
  rank: null,
};

type FinishFlag = RunFlag | "bad_token" | "run_mismatch" | "reused";

export async function finishRun(
  q: Db,
  runId: string,
  input: FinishInput,
  ctx: FinishContext,
): Promise<{ response: FinishRunResponse; flag: FinishFlag | null }> {
  const { now } = ctx;
  const token = verifyToken("run", input.token, runTokenSchema);
  if (!token) return reject(runId, "bad_token");
  if (token.id !== runId) return reject(runId, "run_mismatch");

  const verdict = validateRun(
    { seed: token.seed, issuedAt: token.iat, tuningVersion: token.tv },
    input,
    now.getTime(),
  );
  // A valid run is scored from the curve at its play time, not from the reported distance. A
  // flagged run keeps what it claimed, for the admin to look at, and earns nothing.
  const score = scoreOf({
    distanceM: verdict.ok ? distanceMAt(input.activeMs) : input.distance,
    garlic: input.garlic,
  });
  const player = await findPlayerByToken(q, ctx.playerToken);
  const campaign = await cachedCampaign();
  const open = boardOpen(campaign, now);

  // The run id is the document's _id, so a token can only be spent once. Two finishes at the
  // same moment may also surface as a duplicate key, which means the same thing.
  let inserted: boolean;
  try {
    inserted = await insertOnce(
      q.runs,
      { _id: runId },
      newRun({
        _id: runId,
        seed: token.seed,
        playerId: player?._id ?? null,
        src: token.src,
        hostOrigin: token.host,
        utm: token.utm,
        language: token.lang,
        tuningVersion: token.tv,
        issuedAt: new Date(token.iat),
        finishedAt: now,
        // Clamp what we store; a forged run can send anything that passed the schema.
        activeMs: Math.min(input.activeMs, 2_147_483_647),
        distanceM: score.distanceM,
        garlic: input.garlic,
        hits: input.hits,
        points: verdict.ok ? score.points : 0,
        status: verdict.ok ? "valid" : "flagged",
        flagReason: verdict.ok ? null : verdict.reason,
        clientVersion: ctx.clientVersion,
        // A known device is saved as it finishes, which also spends the run for anyone else, so
        // one run can't be credited to two players.
        savedAt: verdict.ok && player && open ? now : null,
      }),
    );
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    inserted = false;
  }
  if (!inserted) return reject(runId, "reused");
  if (!verdict.ok) return reject(runId, verdict.reason);

  let best = null;
  let rank: number | null = null;
  if (player) {
    if (open) await updateBestRun(q, player._id, { ...score, runId, at: now });
    best = await bestOf(q, player._id);
    rank = await rankOfPlayer(q, player._id);
    void touchPlayerToken(q, ctx.playerToken!).catch(() => {});
  }
  const preview = open ? await rankPreview(q, score, player?._id ?? null) : null;
  // A known player's run is already saved, so only a new player needs the token.
  const saveToken =
    open && !player
      ? signToken("save", {
          v: 1,
          run: runId,
          exp: now.getTime() + SAVE_WINDOW_MS,
        } satisfies typeof saveTokenSchema._output)
      : null;

  log.info("run_finished", {
    runId,
    points: score.points,
    distance: Math.round(score.distanceM),
    garlic: input.garlic,
    hits: input.hits,
  });
  return {
    response: { valid: true, points: score.points, saveToken, best, rankPreview: preview, rank },
    flag: null,
  };
}

function reject(runId: string, flag: FinishFlag) {
  log.warn("run_flagged", { runId, reason: flag });
  return { response: INVALID, flag };
}
