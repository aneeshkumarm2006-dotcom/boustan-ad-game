/**
 * Fetch client for the real endpoints. No cookies (EMB-07): the player token travels in the
 * `X-Player-Token` header, and the build id in `X-Client-Version` (stored on runs).
 */
import {
  ApiError,
  type ApiErrorCode,
  type FinishRunRequest,
  type FinishRunResponse,
  type GameApi,
  type LeaderboardResponse,
  type SaveScoreRequest,
  type SaveScoreResponse,
  type StartRunRequest,
  type StartRunResponse,
} from "./types";

const CLIENT_VERSION = process.env.NEXT_PUBLIC_CLIENT_VERSION || "dev";
/**
 * Error codes the server sends that the UI tells apart; anything else is "rejected". "closed"
 * comes with a 409 when the contest closed before the score was saved.
 */
const PASSED_THROUGH = new Set<string>(["bad_email", "closed"]);

async function call<T>(
  path: string,
  init: RequestInit & { playerToken?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-client-version": CLIENT_VERSION,
  };
  if (init.playerToken) headers["x-player-token"] = init.playerToken;
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, credentials: "omit", cache: "no-store" });
  } catch {
    throw new ApiError("network");
  }
  if (res.status === 429) throw new ApiError("rate_limited");
  // A save token past its 30 minutes.
  if (res.status === 410) throw new ApiError("expired");
  if (res.status >= 500) throw new ApiError("network");
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const code = body?.error;
    throw new ApiError(code && PASSED_THROUGH.has(code) ? (code as ApiErrorCode) : "rejected");
  }
  return (await res.json()) as T;
}

export function createHttpApi(): GameApi {
  return {
    registerPlayer: (req) =>
      call<SaveScoreResponse>("/api/players/register", {
        method: "POST",
        body: JSON.stringify(req),
      }),
    startRun: (req: StartRunRequest) =>
      call<StartRunResponse>("/api/runs/start", { method: "POST", body: JSON.stringify(req) }),
    finishRun: (runId: string, req: FinishRunRequest, playerToken?: string) =>
      call<FinishRunResponse>(`/api/runs/${encodeURIComponent(runId)}/finish`, {
        method: "POST",
        body: JSON.stringify(req),
        playerToken,
      }),
    // A new player's save: the email identifies them, so no player token goes with it.
    saveScore: (req: SaveScoreRequest) =>
      call<SaveScoreResponse>("/api/score", { method: "POST", body: JSON.stringify(req) }),
    leaderboard: (limit: number, playerToken?: string) =>
      call<LeaderboardResponse>(`/api/leaderboard?limit=${limit}`, { playerToken }),
  };
}
