/**
 * In-browser mock of the game API, for development and the end-to-end suite without a
 * database (NEXT_PUBLIC_API_MODE=mock). It applies the server's rules: the run checks of
 * game-core validateRun (SEC-02), points from the speed curve at `activeMs` plus 10 per garlic,
 * a best that only a strictly better run replaces, the leaderboard order (most points, then
 * whoever got there first) and single-use save tokens that last 30 minutes. State lives in
 * localStorage, so reloads and returning devices behave like the real thing.
 *
 * Scenarios for testing contest states and failures, comma-separated in `?mock=`:
 *   offline        startRun fails, so the run plays with a local seed (§3.4)
 *   not_started    the contest hasn't started; ended: the contest is over
 *   board_off      the leaderboard switch is off
 *   save_error     the first save attempt fails with a network error
 *   invalid        every finished run fails validation
 *   slow           every call takes 1.5 s
 */
import {
  TUNING,
  compareScores,
  distanceMAt,
  isBetterScore,
  scoreOf,
  validateRun,
  type RunScore,
} from "@/game-core";
import { looksLikeEmail, normalizeEmail } from "@/lib/email";
import { autoNickname, cleanNickname } from "@/lib/nicknames";
import { readJson, writeJson } from "@/lib/storage";
import {
  ApiError,
  isContestOpen,
  type CampaignState,
  type FinishRunRequest,
  type FinishRunResponse,
  type GameApi,
  type LeaderboardEntry,
  type LeaderboardResponse,
  type SaveScoreRequest,
  type SaveScoreResponse,
  type StartRunResponse,
} from "./types";

const SAVE_TOKEN_TTL_MS = 30 * 60 * 1000;

interface MockRun {
  seed: number;
  issuedAt: number;
  used: boolean;
}
interface MockSaveToken {
  score: RunScore;
  /** When the run finished: a saved best counts from then, as on the server. */
  finishedAt: number;
  expiresAt: number;
  /** The player token it was spent for. */
  usedBy: string | null;
}
interface MockPlayer {
  email: string;
  nickname: string;
  best: RunScore | null;
  bestAt: number;
}
interface MockDb {
  runs: Record<string, MockRun>;
  saveTokens: Record<string, MockSaveToken>;
  /** player token → player */
  players: Record<string, MockPlayer>;
  firstSaveFailed: boolean;
}

const EMPTY_DB: MockDb = { runs: {}, saveTokens: {}, players: {}, firstSaveFailed: false };

function isDb(value: unknown): value is MockDb {
  return (
    typeof value === "object" &&
    value !== null &&
    "runs" in value &&
    "saveTokens" in value &&
    "players" in value
  );
}

function randomId(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A believable board that the player's saved scores slot into, best first. */
const FAKE_BOARD: { name: string; points: number }[] = [
  { name: "Toum Turbo 81", points: 884 },
  { name: "Falafel Zoom 27", points: 812 },
  { name: "Pita Pilote 12", points: 745 },
  { name: "Kafta Express 44", points: 690 },
  { name: "Navet Ninja 9", points: 633 },
  { name: "Patate Pirate 63", points: 571 },
  { name: "Sumac Sonic 5", points: 528 },
  { name: "Taboulé Turbo 88", points: 486 },
  { name: "Labneh Flash 31", points: 441 },
  { name: "Hummus Héros 70", points: 402 },
  { name: "Za'atar Zoom 16", points: 367 },
  { name: "Baklava Bolide 5", points: 330 },
];

interface Row {
  name: string;
  points: number;
  /** When the score was reached: equal points go to whoever got there first. */
  at: number;
  token: string;
}

export function createMockApi(search: string): GameApi {
  const scenarios = new Set(
    (new URLSearchParams(search).get("mock") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const has = (s: string) => scenarios.has(s);
  const latency = has("slow") ? 1500 : 120;
  const wait = () => new Promise<void>((resolve) => setTimeout(resolve, latency));

  const load = (): MockDb => readJson("mock-db", isDb) ?? structuredClone(EMPTY_DB);
  const save = (db: MockDb) => writeJson("mock-db", db);

  function campaign(): CampaignState {
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const status = has("not_started") ? "not_started" : has("ended") ? "ended" : "active";
    return {
      status,
      startsAt: new Date(status === "not_started" ? now + 3 * day : now - 3 * day).toISOString(),
      endsAt: new Date(status === "ended" ? now - day : now + 27 * day).toISOString(),
      leaderboardOpen: !has("board_off"),
    };
  }

  /** The fake board and every saved best, in leaderboard order. */
  function board(db: MockDb): Row[] {
    return [
      // The fake players got there long ago, so they win ties.
      ...FAKE_BOARD.map((r, i) => ({ ...r, at: i, token: "" })),
      ...Object.entries(db.players).flatMap(([token, p]) =>
        p.best ? [{ name: p.nickname, points: p.best.points, at: p.bestAt, token }] : [],
      ),
    ].sort((a, b) => compareScores(a, b) || a.at - b.at);
  }

  /** 1 + the rows ranked above `points` reached at `at`, leaving out the player's own row. */
  function rankOf(db: MockDb, points: number, at: number, exceptToken?: string): number {
    const above = board(db).filter(
      (r) =>
        r.token !== exceptToken &&
        (compareScores(r, { points }) < 0 || (r.points === points && r.at < at)),
    );
    return 1 + above.length;
  }

  const entry = (r: Row, i: number): LeaderboardEntry => ({
    rank: i + 1,
    name: r.name,
    points: r.points,
  });

  return {
    async registerPlayer(req) {
      await wait();
      if (has("offline")) throw new ApiError("network");
      if (!looksLikeEmail(req.email) || !req.termsAge || !cleanNickname(req.nickname))
        throw new ApiError("rejected");
      const db = load();
      const email = normalizeEmail(req.email);
      const known = Object.entries(db.players).find(
        ([, p]) => normalizeEmail(p.email) === email,
      )?.[0];
      const playerToken = known ?? randomId();
      db.players[playerToken] ??= {
        email,
        nickname: cleanNickname(req.nickname)!,
        best: null,
        bestAt: Date.now(),
      };
      save(db);
      return { playerToken, rank: null, best: db.players[playerToken].best };
    },
    async startRun(): Promise<StartRunResponse> {
      await wait();
      if (has("offline")) throw new ApiError("network");
      const db = load();
      const runId = randomId();
      const seed = crypto.getRandomValues(new Uint32Array(1))[0];
      db.runs[runId] = { seed, issuedAt: Date.now(), used: false };
      save(db);
      return { runId, seed, token: `mock.${runId}`, campaign: campaign() };
    },

    async finishRun(
      runId: string,
      req: FinishRunRequest,
      playerToken?: string,
    ): Promise<FinishRunResponse> {
      await wait();
      const db = load();
      const run = db.runs[runId];
      const now = Date.now();
      const valid =
        !has("invalid") &&
        run !== undefined &&
        req.token === `mock.${runId}` &&
        !run.used &&
        validateRun(
          { seed: run.seed, issuedAt: run.issuedAt, tuningVersion: TUNING.version },
          req,
          now,
        ).ok;
      if (run) run.used = true;
      if (!valid) {
        save(db);
        return {
          valid: false,
          points: 0,
          saveToken: null,
          best: null,
          rankPreview: null,
          rank: null,
        };
      }
      // Scored from the curve at the run's play time, as on the server.
      const score = scoreOf({ distanceM: distanceMAt(req.activeMs), garlic: req.garlic });
      const open = isContestOpen(campaign());
      const player = playerToken ? db.players[playerToken] : undefined;
      // A known device is saved as it finishes (LB-02), while the contest is open.
      if (player && open && isBetterScore(score, player.best)) {
        player.best = score;
        player.bestAt = now;
      }
      // Only a new player needs a token to put the run on the board.
      let saveToken: string | null = null;
      if (open && !player) {
        saveToken = randomId();
        db.saveTokens[saveToken] = {
          score,
          finishedAt: now,
          expiresAt: now + SAVE_TOKEN_TTL_MS,
          usedBy: null,
        };
      }
      save(db);
      return {
        valid: true,
        points: score.points,
        saveToken,
        best: player?.best ?? null,
        rankPreview: open ? rankOf(db, score.points, now, playerToken) : null,
        rank: player?.best ? rankOf(db, player.best.points, player.bestAt, playerToken) : null,
      };
    },

    async saveScore(req: SaveScoreRequest): Promise<SaveScoreResponse> {
      await wait();
      const db = load();
      if (has("save_error") && !db.firstSaveFailed) {
        db.firstSaveFailed = true;
        save(db);
        throw new ApiError("network");
      }
      const token = db.saveTokens[req.saveToken];
      if (!token) throw new ApiError("rejected");
      if (Date.now() > token.expiresAt) throw new ApiError("expired");
      if (!looksLikeEmail(req.email) || !req.termsAge) throw new ApiError("rejected");
      if (!isContestOpen(campaign())) throw new ApiError("closed");

      const normalized = normalizeEmail(req.email);
      const known = Object.entries(db.players).find(
        ([, p]) => normalizeEmail(p.email) === normalized,
      )?.[0];
      // A spent token from the same player is a retry after a lost response: answer the same.
      if (token.usedBy !== null && token.usedBy !== known) throw new ApiError("expired");
      const playerToken = known ?? randomId();
      const player: MockPlayer = db.players[playerToken] ?? {
        email: req.email.trim(),
        nickname: "",
        best: null,
        bestAt: token.finishedAt,
      };
      const nickname = cleanNickname(req.nickname);
      if (nickname) player.nickname = nickname;
      if (!player.nickname) player.nickname = autoNickname();
      if (isBetterScore(token.score, player.best)) {
        player.best = token.score;
        player.bestAt = token.finishedAt;
      }
      db.players[playerToken] = player;
      token.usedBy = playerToken;
      save(db);
      return {
        playerToken,
        rank: player.best ? rankOf(db, player.best.points, player.bestAt, playerToken) : null,
        best: player.best,
      };
    },

    async leaderboard(limit: number, playerToken?: string): Promise<LeaderboardResponse> {
      await wait();
      const rows = board(load());
      const mine = playerToken ? rows.findIndex((r) => r.token === playerToken) : -1;
      return {
        top: rows.slice(0, limit).map(entry),
        ...(mine >= 0 ? { me: entry(rows[mine], mine) } : {}),
      };
    },
  };
}
