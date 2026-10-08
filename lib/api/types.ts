/**
 * Client view of the game API. In development and the end-to-end suite it runs on the mock in
 * ./mock.ts; in production the real endpoints sit behind the same interface (./http.ts).
 *
 * The game is a points contest: a run is worth 1 point per metre plus 10 per garlic, and the top 3
 * players on the leaderboard win. A player appears on the leaderboard once their score is saved
 * with an email (so the winners can be reached). A returning device is already known to the
 * server, so its best run is saved when the run finishes and there is nothing more to "Save".
 *
 * - `startRun` also returns the campaign state, so the start screen can show the contest dates
 *   and the leaderboard switch without another request.
 * - `finishRun`, `saveScore` and `leaderboard` take the player token as a header, so the server
 *   can return the player's best and rank (EMB-07: tokens in headers, no cookies).
 */
import type { Lang } from "@/i18n";
import type { RunScore } from "@/game-core";
import type { Utm } from "@/lib/session";

export interface CampaignState {
  status: "not_started" | "active" | "ended";
  /** ISO dates, for "The contest starts Oct 15" style messages. */
  startsAt: string | null;
  endsAt: string | null;
  /** The leaderboard switch: off means scores don't count right now. */
  leaderboardOpen: boolean;
}

/** Whether a score counts towards the leaderboard right now. Unknown (offline) counts as open. */
export function isContestOpen(campaign: CampaignState | null): boolean {
  return campaign ? campaign.status === "active" && campaign.leaderboardOpen : true;
}

export interface StartRunRequest {
  src: string | null;
  lang: Lang;
  utm: Utm;
  host: string | null;
}

export interface StartRunResponse {
  runId: string;
  seed: number;
  token: string;
  campaign: CampaignState;
}

export interface FinishRunRequest {
  token: string;
  /** Metres, unrounded. */
  distance: number;
  garlic: number;
  hits: number;
  activeMs: number;
}

export interface FinishRunResponse {
  valid: boolean;
  /** What the server scored the run (1 per metre plus 10 per garlic). 0 when it isn't valid. */
  points: number;
  /**
   * Single use, valid 30 min (SEC-04): lets a new player put this run on the leaderboard. Null
   * when the run isn't valid or the contest isn't open.
   */
  saveToken: string | null;
  /** The player's best validated run, when the player token is known. */
  best: RunScore | null;
  /** Rank this run would have on the leaderboard. Null when the contest isn't open. */
  rankPreview: number | null;
  /**
   * The player's own rank, when the player token is known: their best was saved at finish, so
   * there is nothing more to "Save" (LB-02, LB-03).
   */
  rank: number | null;
}

export interface SaveScoreRequest {
  saveToken: string;
  email: string;
  nickname?: string;
  lang: Lang;
  termsAge: boolean;
  marketingOptIn: boolean;
  /** Cloudflare Turnstile token (SEC-05). */
  turnstileToken: string;
  src: string | null;
  utm: Utm;
}

export interface SaveScoreResponse {
  /** The device token to keep: later runs from this device are saved as they finish. */
  playerToken: string;
  rank: number | null;
  best: RunScore | null;
}

export interface LeaderboardEntry {
  rank: number;
  name: string;
  points: number;
}

export interface LeaderboardResponse {
  top: LeaderboardEntry[];
  me?: LeaderboardEntry;
}

export type ApiErrorCode =
  | "network"
  | "invalid_run"
  | "expired"
  | "rejected"
  | "rate_limited"
  /** The save used a disposable or malformed address (DATA-04). */
  | "bad_email"
  /** The contest closed (ended, not started or switched off) before the score was saved. */
  | "closed";

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface GameApi {
  registerPlayer(req: Omit<SaveScoreRequest, "saveToken">): Promise<SaveScoreResponse>;
  startRun(req: StartRunRequest): Promise<StartRunResponse>;
  finishRun(runId: string, req: FinishRunRequest, playerToken?: string): Promise<FinishRunResponse>;
  saveScore(req: SaveScoreRequest): Promise<SaveScoreResponse>;
  leaderboard(limit: number, playerToken?: string): Promise<LeaderboardResponse>;
}
