/**
 * Client view of the game API (PRD §15.3). Stage 1 runs on the mock in ./mock.ts; Stage 2
 * builds the real endpoints behind the same interface (./http.ts).
 *
 * Additions to §15.3, to carry into Stage 2:
 * - `startRun` also returns the campaign state, so the start screen can show reward cards,
 *   "All gone" and campaign-window messages without another request (§3.4).
 * - `finishRun`, `claim` and `leaderboard` take the player token as a header, so the server can
 *   return the player's best and rank (EMB-07: tokens in headers, no cookies).
 * - `resend` accepts the player token instead of an email after a one-tap claim.
 */
import type { Lang } from "@/i18n";
import type { RewardId, RewardRules, RunScore } from "@/game-core";
import type { Utm } from "@/lib/session";

export type RewardAvailability =
  { available: true } | { available: false; reason: "sold_out" | "paused" };

export interface CampaignState {
  status: "not_started" | "active" | "ended";
  /** ISO dates, for "Rewards start Oct 15" style messages. */
  startsAt: string | null;
  endsAt: string | null;
  claimsEnabled: boolean;
  rules: RewardRules;
  rewards: Record<RewardId, RewardAvailability>;
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
  /** Rewards this run unlocked that can still be claimed. */
  unlocked: RewardId[];
  /** Single use, valid 30 min (SEC-04, RWD-08). Also used to save a score. */
  claimToken: string | null;
  /** The player's best validated run, when the player token is known. */
  best: RunScore | null;
  /** Rank this run would have on the leaderboard. */
  rankPreview: number | null;
  /**
   * The player's own rank after this run, when the player token is known: their best was saved
   * at finish, so there is nothing more to "Save" (LB-02, LB-03).
   */
  rank: number | null;
}

export interface ClaimRequest {
  claimToken: string;
  /** Either an email or a known player token (one-tap claim). */
  email?: string;
  playerToken?: string;
  nickname?: string;
  lang: Lang;
  termsAge: boolean;
  marketingOptIn: boolean;
  /** Cloudflare Turnstile token (SEC-05). */
  turnstileToken: string;
  src: string | null;
  utm: Utm;
}

export interface IssuedCode {
  reward: RewardId;
  code: string;
  /** ISO date. */
  expiresAt: string;
}

export interface ClaimResponse {
  codes: IssuedCode[];
  /** Already claimed with this email: no new code, the original was re-sent (§3.4). */
  alreadyClaimed: RewardId[];
  /** Unlocked but can't be claimed now: pool empty, reward paused or claims off (RWD-04). */
  unavailable: RewardId[];
  playerToken: string;
  rank: number | null;
}

export interface LeaderboardEntry {
  rank: number;
  name: string;
  garlic: number;
  hits: number;
  distanceM: number;
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
  | "all_gone"
  /** The claim used a disposable or malformed address (DATA-04). */
  | "bad_email"
  /** The saved player token is no longer recognized; ask for the email again. */
  | "unknown_player";

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
  startRun(req: StartRunRequest): Promise<StartRunResponse>;
  finishRun(runId: string, req: FinishRunRequest, playerToken?: string): Promise<FinishRunResponse>;
  claim(req: ClaimRequest): Promise<ClaimResponse>;
  /** Always resolves (202) unless the network fails (MAIL-08). */
  resend(who: { email: string } | { playerToken: string }): Promise<void>;
  leaderboard(limit: number, playerToken?: string): Promise<LeaderboardResponse>;
}
