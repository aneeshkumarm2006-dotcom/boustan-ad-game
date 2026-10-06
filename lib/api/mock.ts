/**
 * In-browser mock of the game API, for development and the end-to-end suite without a
 * database (NEXT_PUBLIC_API_MODE=mock). It runs the server's run checks (game-core
 * validateRun, SEC-02), so client numbers are tested against them. State lives in localStorage
 * so reloads, "My rewards" and repeat claims behave like the real thing. Codes start with
 * TEST- and are worthless.
 *
 * Scenarios for testing campaign states and failures, comma-separated in `?mock=`:
 *   offline        startRun fails, so the run plays with a local seed (§3.4)
 *   not_started    campaign hasn't started; ended: campaign is over
 *   claims_off     global claims_enabled kill switch is off
 *   soldout_coke   soldout_garlic   paused_coke   paused_garlic
 *   claim_error    the first claim attempt fails with a network error
 *   invalid        every finished run fails validation
 *   slow           every call takes 1.5 s
 */
import {
  DEFAULT_REWARD_RULES,
  REWARD_IDS,
  TUNING,
  compareScores,
  isBetterScore,
  unlockedRewards,
  validateRun,
  type RewardId,
  type RunScore,
} from "@/game-core";
import { normalizeEmail } from "@/lib/email";
import { readJson, writeJson } from "@/lib/storage";
import {
  ApiError,
  type CampaignState,
  type ClaimRequest,
  type ClaimResponse,
  type FinishRunRequest,
  type FinishRunResponse,
  type GameApi,
  type LeaderboardEntry,
  type LeaderboardResponse,
  type StartRunResponse,
} from "./types";

const CLAIM_TOKEN_TTL_MS = 30 * 60 * 1000;
const CODE_VALID_DAYS = 30;

interface MockRun {
  seed: number;
  issuedAt: number;
  used: boolean;
}
interface MockClaimToken {
  runId: string;
  unlocked: RewardId[];
  score: RunScore;
  expiresAt: number;
  used: boolean;
}
interface MockPlayer {
  email: string;
  nickname: string;
  best: RunScore | null;
  bestAt: number;
}
interface MockDb {
  runs: Record<string, MockRun>;
  claimTokens: Record<string, MockClaimToken>;
  /** player token → player */
  players: Record<string, MockPlayer>;
  /** normalized email → reward → code */
  claims: Record<string, Partial<Record<RewardId, string>>>;
  firstClaimFailed: boolean;
}

const EMPTY_DB: MockDb = {
  runs: {},
  claimTokens: {},
  players: {},
  claims: {},
  firstClaimFailed: false,
};

function isDb(value: unknown): value is MockDb {
  return typeof value === "object" && value !== null && "runs" in value && "players" in value;
}

function randomId(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function testCode(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  const chars = Array.from(buf, (b) => CROCKFORD[b & 31]).join("");
  return `TEST-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

const NAMES = [
  "Toum Turbo 81",
  "Falafel Rapide 27",
  "Pita Pilote 12",
  "Shawarma Express 44",
  "Navet Ninja 9",
  "Patate Pirate 63",
  "Sumac Sonic 5",
  "Taboulé Turbo 88",
  "Fattouche Flash 31",
  "Hummus Héros 70",
  "Za'atar Zoom 16",
  "Baklava Bolide 52",
];

/** A believable board that the player's saved scores slot into. */
function fakeBoard(): (RunScore & { name: string; at: number })[] {
  return NAMES.map((name, i) => ({
    name,
    garlic: Math.max(2, 24 - i * 2 - (i % 3)),
    hits: i % 4,
    distanceM: 420 - i * 27,
    at: i,
  }));
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

  const load = (): MockDb => ({ ...EMPTY_DB, ...readJson("mock-db", isDb) });
  const save = (db: MockDb) => writeJson("mock-db", db);

  function campaign(): CampaignState {
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const status = has("not_started") ? "not_started" : has("ended") ? "ended" : "active";
    const reward = (id: "coke" | "garlic") =>
      has(`soldout_${id}`)
        ? ({ available: false, reason: "sold_out" } as const)
        : has(`paused_${id}`)
          ? ({ available: false, reason: "paused" } as const)
          : ({ available: true } as const);
    return {
      status,
      startsAt: new Date(status === "not_started" ? now + 3 * day : now - 3 * day).toISOString(),
      endsAt: new Date(status === "ended" ? now - day : now + 27 * day).toISOString(),
      claimsEnabled: !has("claims_off"),
      rules: DEFAULT_REWARD_RULES,
      rewards: { free_coke: reward("coke"), free_garlic_sauce: reward("garlic") },
    };
  }

  function rankOf(db: MockDb, score: RunScore, at: number, exceptToken?: string): number {
    const rows = [
      ...fakeBoard(),
      ...Object.entries(db.players)
        .filter(([token, p]) => token !== exceptToken && p.best)
        .map(([, p]) => ({ ...(p.best as RunScore), at: p.bestAt })),
    ];
    return (
      1 +
      rows.filter(
        (r) => compareScores(r, score) < 0 || (compareScores(r, score) === 0 && r.at < at),
      ).length
    );
  }

  return {
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
      const score: RunScore = { distanceM: req.distance, garlic: req.garlic, hits: req.hits };
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
          unlocked: [],
          claimToken: null,
          best: null,
          rankPreview: null,
          rank: null,
        };
      }
      const c = campaign();
      const open = c.status === "active" && c.claimsEnabled;
      const unlocked = open
        ? unlockedRewards(score, c.rules).filter((id) => c.rewards[id].available)
        : [];
      const claimToken = randomId();
      db.claimTokens[claimToken] = {
        runId,
        unlocked,
        score,
        expiresAt: now + CLAIM_TOKEN_TTL_MS,
        used: false,
      };
      const player = playerToken ? db.players[playerToken] : undefined;
      // A known player's best is saved at finish, as on the server (LB-02).
      if (player && (!player.best || isBetterScore(score, player.best))) {
        player.best = score;
        player.bestAt = now;
      }
      const best = player?.best ?? score;
      save(db);
      return {
        valid: true,
        unlocked,
        claimToken,
        best: player ? best : null,
        rankPreview: rankOf(db, score, now, playerToken),
        rank: player?.best ? rankOf(db, player.best, player.bestAt, playerToken) : null,
      };
    },

    async claim(req: ClaimRequest): Promise<ClaimResponse> {
      await wait();
      const db = load();
      if (has("claim_error") && !db.firstClaimFailed) {
        db.firstClaimFailed = true;
        save(db);
        throw new ApiError("network");
      }
      const token = db.claimTokens[req.claimToken];
      if (!token || token.used || Date.now() > token.expiresAt) throw new ApiError("expired");
      if (!req.termsAge) throw new ApiError("rejected");

      let playerToken =
        req.playerToken && db.players[req.playerToken] ? req.playerToken : undefined;
      const email = playerToken ? db.players[playerToken].email : req.email?.trim();
      if (!email) throw new ApiError("rejected");
      const normalized = normalizeEmail(email);
      if (!playerToken) {
        playerToken =
          Object.entries(db.players).find(([, p]) => normalizeEmail(p.email) === normalized)?.[0] ??
          randomId();
      }
      const now = Date.now();
      const existing = db.players[playerToken];
      const player: MockPlayer = existing ?? { email, nickname: "", best: null, bestAt: now };
      if (req.nickname?.trim()) player.nickname = req.nickname.trim();
      if (!player.nickname) player.nickname = NAMES[Math.floor(Math.random() * NAMES.length)];
      if (isBetterScore(token.score, player.best)) {
        player.best = token.score;
        player.bestAt = now;
      }
      db.players[playerToken] = player;

      const c = campaign();
      const claimed = (db.claims[normalized] ??= {});
      const codes: ClaimResponse["codes"] = [];
      const alreadyClaimed: RewardId[] = [];
      const unavailable: RewardId[] = [];
      for (const reward of REWARD_IDS.filter((id) => token.unlocked.includes(id))) {
        if (claimed[reward]) {
          alreadyClaimed.push(reward);
        } else if (!c.rewards[reward].available) {
          unavailable.push(reward);
        } else {
          const code = testCode();
          claimed[reward] = code;
          codes.push({
            reward,
            code,
            expiresAt: new Date(now + CODE_VALID_DAYS * 24 * 60 * 60 * 1000).toISOString(),
          });
        }
      }
      token.used = true;
      save(db);
      return {
        codes,
        alreadyClaimed,
        unavailable,
        playerToken,
        rank: player.best ? rankOf(db, player.best, player.bestAt, playerToken) : null,
      };
    },

    async resend() {
      await wait();
    },

    async leaderboard(limit: number, playerToken?: string): Promise<LeaderboardResponse> {
      await wait();
      const db = load();
      const rows = [
        ...fakeBoard().map((r) => ({ ...r, token: "" })),
        ...Object.entries(db.players)
          .filter(([, p]) => p.best)
          .map(([token, p]) => ({
            ...(p.best as RunScore),
            name: p.nickname,
            at: p.bestAt,
            token,
          })),
      ].sort((a, b) => compareScores(a, b) || a.at - b.at);
      const entries = rows.map((r, i): LeaderboardEntry & { token: string } => ({
        rank: i + 1,
        name: r.name,
        garlic: r.garlic,
        hits: r.hits,
        distanceM: r.distanceM,
        token: r.token,
      }));
      const strip = (e: LeaderboardEntry & { token: string }): LeaderboardEntry => ({
        rank: e.rank,
        name: e.name,
        garlic: e.garlic,
        hits: e.hits,
        distanceM: e.distanceM,
      });
      const mine = playerToken ? entries.find((e) => e.token === playerToken) : undefined;
      return { top: entries.slice(0, limit).map(strip), me: mine ? strip(mine) : undefined };
    },
  };
}
