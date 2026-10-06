/**
 * Run start and finish (SEC-01 to SEC-04). Starting a run writes nothing: the token carries
 * everything finish needs. Finish writes the run row once, keyed by the run id, so a token
 * can't be spent twice; then it validates the numbers against the seed (game-core).
 */
import { randomInt, randomUUID } from "node:crypto";
import { insertOnce, isDuplicateKey, type Db } from "@/db/client";
import { newRun } from "@/db/schema";
import { TUNING, unlockedRewards, validateRun, type RunFlag } from "@/game-core";
import type { Lang } from "@/i18n";
import type { FinishRunResponse, StartRunResponse } from "@/lib/api/types";
import type { Utm } from "@/lib/session";
import { cachedCampaign, campaignState, rewardClaimable, rewardRules, runRules } from "./campaign";
import { bestOf, rankOfPlayer, rankPreview, updateBestRun } from "./leaderboard";
import { log } from "./log";
import { findPlayerByToken, touchPlayerToken } from "./players";
import { claimTokenSchema, runTokenSchema, signToken, verifyToken } from "./tokens";

/** Rewards unlocked in a run can be claimed for this long (SEC-04, RWD-08). */
export const CLAIM_WINDOW_MS = 30 * 60 * 1000;

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
    rules: runRules(campaign),
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
  unlocked: [],
  claimToken: null,
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

  const score = { distanceM: input.distance, garlic: input.garlic, hits: input.hits };
  const verdict = validateRun(
    { seed: token.seed, issuedAt: token.iat, tuningVersion: token.tv },
    input,
    now.getTime(),
  );
  const player = await findPlayerByToken(q, ctx.playerToken);

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
        rules: token.rules,
        tuningVersion: token.tv,
        issuedAt: new Date(token.iat),
        finishedAt: now,
        // Clamp what we store; a forged run can send anything that passed the schema.
        activeMs: Math.min(input.activeMs, 2_147_483_647),
        distanceM: input.distance,
        garlic: input.garlic,
        hits: input.hits,
        status: verdict.ok ? "valid" : "flagged",
        flagReason: verdict.ok ? null : verdict.reason,
        clientVersion: ctx.clientVersion,
      }),
    );
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    inserted = false;
  }
  if (!inserted) return reject(runId, "reused");
  if (!verdict.ok) return reject(runId, verdict.reason);

  const campaign = await cachedCampaign();
  const unlocked = unlockedRewards(score, rewardRules(token.rules)).filter((id) =>
    rewardClaimable(campaign, id, now),
  );

  let best = null;
  let rank: number | null = null;
  if (player) {
    await updateBestRun(q, player._id, { ...score, runId, at: now });
    best = await bestOf(q, player._id);
    rank = await rankOfPlayer(q, player._id);
    void touchPlayerToken(q, ctx.playerToken!).catch(() => {});
  }
  const preview = await rankPreview(q, score, player?._id ?? null);
  const claimToken = signToken("claim", {
    v: 1,
    run: runId,
    exp: now.getTime() + CLAIM_WINDOW_MS,
  } satisfies typeof claimTokenSchema._output);

  log.info("run_finished", {
    runId,
    distance: Math.round(score.distanceM),
    garlic: score.garlic,
    hits: score.hits,
    unlocked: unlocked.join(","),
  });
  return {
    response: { valid: true, unlocked, claimToken, best, rankPreview: preview, rank },
    flag: null,
  };
}

function reject(runId: string, flag: FinishFlag) {
  log.warn("run_flagged", { runId, reason: flag });
  return { response: INVALID, flag };
}
