"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  DEFAULT_REWARD_RULES,
  REWARD_IDS,
  TUNING,
  levelDigest,
  randomSeed,
  type RewardId,
  type RunScore,
} from "@/game-core";
import { createTranslator, pickLanguage, type Lang } from "@/i18n";
import {
  ApiError,
  createApi,
  type CampaignState,
  type ClaimResponse,
  type GameApi,
  type IssuedCode,
  type LeaderboardEntry,
  type StartRunResponse,
} from "@/lib/api";
import type { HostPattern } from "@/lib/embed/allowed-hosts";
import { createAnalytics, type Analytics } from "@/lib/analytics";
import type { ClientEvent, EventProps } from "@/lib/analytics-events";
import { createBridge, type Bridge, type HostCommand, type HostEvent } from "@/lib/embed/bridge";
import { maskEmail } from "@/lib/email";
import { shareUrl } from "@/lib/links";
import {
  addCodes,
  loadBest,
  loadCodes,
  loadPending,
  loadPlayer,
  recordLocalBest,
  savePending,
  savePlayer,
  type PendingClaim,
  type SavedPlayer,
} from "@/lib/player";
import {
  attributionQuery,
  hostOrigin,
  isFramed,
  parseLaunchParams,
  type LaunchParams,
} from "@/lib/session";
import { readString, writeString } from "@/lib/storage";
// Imported statically: a separate chunk only started downloading after hydration, which cost
// ~300 ms of first-playable time on 4G (EMB-11). It adds ~10 KB gzipped to the page.
import { Game, type GameEvent, type GameState, type RunResult } from "../engine";
import { LeaderboardScreen, MyRewardsScreen } from "./BoardScreens";
import { ClaimScreen, type ClaimErrorKey, type ClaimSubmit } from "./ClaimScreen";
import { UiContext, type Ui } from "./context";
import { CouponScreen } from "./CouponScreen";
import { BrandLogo, CheckIcon, Overlay, PauseIcon, PixelIcon, Tools } from "./parts";
import { ResultsScreen, type FinishState } from "./ResultsScreen";
import { shareOrCopy } from "./share";
import { StartScreen } from "./StartScreen";

type Screen =
  | { name: "start" }
  | { name: "play" }
  | { name: "results" }
  | { name: "claim"; mode: "claim" | "save"; back: "start" | "results" }
  | {
      name: "coupon";
      claim: ClaimResponse;
      emailMasked: string | null;
      resendTo: { email: string } | { playerToken: string };
    }
  | { name: "leaderboard"; back: "start" | "results" }
  | { name: "rewards"; back: "start" | "results" };

interface Boot {
  params: LaunchParams;
  framed: boolean;
  host: string | null;
  api: GameApi;
  reducedMotion: boolean;
  portrait: boolean;
  /** Starting values; React state takes over once the player changes them. */
  lang: Lang;
  muted: boolean;
  player: SavedPlayer | null;
  best: RunScore | null;
  codes: IssuedCode[];
  pending: PendingClaim | null;
}

/** Viewport narrower than this ratio gets the taller canvas (reference behaviour). */
const PORTRAIT_QUERY = `(max-aspect-ratio: 20/23)`;
/** EMB-01: below this, an iframe shows "Play full screen" instead of the game. */
const MIN_EMBED = { w: 300, h: 400 };
const RUN_START_WAIT_MS = 1200;
const CLAIM_WINDOW_MS = 30 * 60 * 1000;
/** Test hooks: set in next.config.ts, never on in production deployments. */
const HOOKS = process.env.STC_HOOKS === "1";
/** First-party analytics only talk to the real API (AN-01). */
const ANALYTICS = process.env.NEXT_PUBLIC_API_MODE === "live";

const backTo = (to: "start" | "results"): Screen =>
  to === "start" ? { name: "start" } : { name: "results" };

let bootCache: Boot | null = null;

/** Page context, read once in the browser. The server render has none (see useBoot). */
function readBoot(): Boot {
  if (bootCache) return bootCache;
  const params = parseLaunchParams(window.location.search);
  const framed = isFramed();
  const savedMuted = readString("muted");
  bootCache = {
    params,
    framed,
    host: hostOrigin(),
    api: createApi(window.location.search),
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    portrait: window.matchMedia(PORTRAIT_QUERY).matches,
    lang: pickLanguage({
      param: params.lang,
      saved: readString("lang"),
      browser: navigator.languages,
    }),
    // GAME-10: off by default in embeds; ?muted=0 turns it on; the player's own choice wins.
    muted: savedMuted === "1" ? true : savedMuted === "0" ? false : (params.muted ?? framed),
    player: loadPlayer(),
    best: loadBest(),
    codes: loadCodes(),
    pending: loadPending(),
  };
  return bootCache;
}

const noSubscribe = () => () => {};
/** Null during the server render and hydration, then the browser context. */
const useBoot = () => useSyncExternalStore(noSubscribe, readBoot, () => null);

/** State that starts from a boot value and is set explicitly afterwards. */
function useStateFrom<T>(initial: T): [T, (value: T) => void] {
  const [set, setSet] = useState<{ value: T } | null>(null);
  const update = useCallback((value: T) => setSet({ value }), []);
  return [set ? set.value : initial, update];
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

export function GameApp({ font, patterns }: { font: string; patterns: HostPattern[] }) {
  const boot = useBoot();
  const [lang, setLangState] = useStateFrom<Lang>(boot?.lang ?? "fr");
  const [muted, setMuted] = useStateFrom(boot?.muted ?? true);
  const [screen, setScreen] = useState<Screen>({ name: "start" });
  const [gameState, setGameState] = useState<GameState>("title");
  const [campaign, setCampaign] = useState<CampaignState | null>(null);
  const [starting, setStarting] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [finish, setFinish] = useState<FinishState>({ status: "pending" });
  const [best, setBest] = useStateFrom<RunScore | null>(boot?.best ?? null);
  const [newBest, setNewBest] = useState(false);
  const [preview, setPreview] = useState<LeaderboardEntry[] | null>(null);
  const [savedRank, setSavedRank] = useState<number | null>(null);
  const [claimCtx, setClaimCtx] = useStateFrom<PendingClaim | null>(boot?.pending ?? null);
  const [player, setPlayer] = useStateFrom<SavedPlayer | null>(boot?.player ?? null);
  const [codes, setCodes] = useStateFrom<IssuedCode[]>(boot?.codes ?? []);
  const [announce, setAnnounce] = useState("");
  const [toastText, setToastText] = useState<string | null>(null);
  const [tooSmall, setTooSmall] = useState(false);
  const [engineReady, setEngineReady] = useState(false);

  const t = useMemo(() => createTranslator(lang), [lang]);
  const appRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const spitRef = useRef<HTMLDivElement>(null);
  const meterFillRef = useRef<HTMLElement>(null);
  const distRef = useRef<HTMLDivElement>(null);
  const distValueRef = useRef<HTMLSpanElement>(null);
  const distBarRef = useRef<HTMLElement>(null);
  const garlicRef = useRef<HTMLDivElement>(null);
  const garlicValueRef = useRef<HTMLSpanElement>(null);
  const gameRef = useRef<Game | null>(null);
  const bridgeRef = useRef<Bridge | null>(null);
  const analyticsRef = useRef<Analytics | null>(null);
  const lastResultRef = useRef<RunResult | null>(null);
  const prefetchRef = useRef<Promise<StartRunResponse | null> | null>(null);
  const runRef = useRef<StartRunResponse | null>(null);
  const startingRef = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastHeight = useRef(0);

  const track = useCallback(
    (name: ClientEvent, props?: EventProps) => analyticsRef.current?.track(name, props),
    [],
  );
  const emit = useCallback(
    (event: HostEvent) => {
      bridgeRef.current?.emit(event);
      // Screens deep in the tree report these through the host bridge; count them too.
      if (event.type === "leaderboard_view") track("leaderboard_view");
      if (event.type === "cta_click") track("cta_click", { target: event.data.target });
    },
    [track],
  );
  const toast = useCallback((message: string) => {
    setToastText(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastText(null), 2200);
  }, []);

  const setLang = useCallback(
    (next: Lang) => {
      if (next !== lang) track("language_switch", { to: next });
      analyticsRef.current?.setLang(next);
      setLangState(next);
      writeString("lang", next);
    },
    [lang, setLangState, track],
  );

  const toggleMuted = useCallback(() => {
    writeString("muted", muted ? "0" : "1");
    setMuted(!muted);
  }, [muted, setMuted]);

  useEffect(() => {
    document.documentElement.lang = lang;
    gameRef.current?.setTranslator(t);
  }, [lang, t]);

  useEffect(() => {
    gameRef.current?.setMuted(muted);
  }, [muted]);

  // ---------- run tokens: fetched ahead so PLAY never waits (§3.3) ----------
  const prefetch = useCallback(() => {
    if (!boot) return;
    const { api, params, host } = boot;
    prefetchRef.current = api
      .startRun({ src: params.src, lang, utm: params.utm, host })
      .then((run) => {
        setCampaign(run.campaign);
        return run;
      })
      .catch(() => null);
  }, [boot, lang]);

  const obtainRun = useCallback(async (): Promise<StartRunResponse | null> => {
    const pending = prefetchRef.current;
    prefetchRef.current = null;
    const run = pending ? await withTimeout(pending, RUN_START_WAIT_MS) : null;
    if (run || !boot) return run;
    // The prefetch failed or never ran: one quick retry before going offline.
    const { api, params, host } = boot;
    const retry = api.startRun({ src: params.src, lang, utm: params.utm, host }).catch(() => null);
    return withTimeout(retry, RUN_START_WAIT_MS);
  }, [boot, lang]);

  const play = useCallback(async () => {
    const game = gameRef.current;
    if (!game || startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    const run = await obtainRun();
    startingRef.current = false;
    setStarting(false);
    if (run) setCampaign(run.campaign);
    const c = run?.campaign ?? campaign;
    const open = c ? c.status === "active" && c.claimsEnabled : true;
    const claimable = Object.fromEntries(
      REWARD_IDS.map((id) => [id, c ? open && c.rewards[id].available : true]),
    ) as Record<RewardId, boolean>;
    runRef.current = run;
    setResult(null);
    setPreview(null);
    setSavedRank(null);
    setNewBest(false);
    game.start({
      seed: run?.seed ?? randomSeed(),
      rules: c?.rules ?? DEFAULT_REWARD_RULES,
      claimable,
    });
    setScreen({ name: "play" });
    emit({ type: "game_start" });
    track("start", { online: run !== null });
    frameRef.current?.focus({ preventScroll: true });
  }, [obtainRun, campaign, emit, track]);

  const submitFinish = useCallback(
    async (run: StartRunResponse, res: RunResult) => {
      if (!boot) return;
      setFinish({ status: "pending" });
      try {
        const out = await boot.api.finishRun(
          run.runId,
          {
            token: run.token,
            distance: res.distanceM,
            garlic: res.garlic,
            hits: res.hits,
            activeMs: res.activeMs,
          },
          loadPlayer()?.token,
        );
        setFinish({ status: "done", res: out });
        if (out.valid && out.claimToken) {
          const ctx: PendingClaim = {
            runId: run.runId,
            claimToken: out.claimToken,
            unlocked: out.unlocked,
            score: { distanceM: res.distanceM, garlic: res.garlic, hits: res.hits },
            expiresAt: Date.now() + CLAIM_WINDOW_MS,
          };
          setClaimCtx(ctx);
          // Keep an unclaimed reward for 30 minutes, even across reloads (§3.4).
          if (out.unlocked.length > 0) savePending(ctx);
          boot.api.leaderboard(3, loadPlayer()?.token).then(
            (lb) => setPreview(lb.top),
            () => setPreview(null),
          );
        }
      } catch {
        setFinish({ status: "error" });
      }
    },
    [boot, setClaimCtx],
  );

  // ---------- engine events ----------
  const onGameEvent = useEffectEvent((event: GameEvent) => {
    switch (event.type) {
      case "ready":
        setEngineReady(true);
        break;
      case "state":
        setGameState(event.state);
        if (event.state === "paused") track("pause");
        break;
      case "milestone":
        emit({ type: "milestone", data: { m: event.m } });
        track("milestone", { m: event.m });
        break;
      case "unlock":
        setAnnounce("");
        setTimeout(() => setAnnounce(event.text), 50);
        if (event.claimable) emit({ type: "reward_unlocked", data: { reward: event.reward } });
        track("reward_unlocked", { reward: event.reward, claimable: event.claimable });
        break;
      case "over": {
        const res = event.result;
        const score = { distanceM: res.distanceM, garlic: res.garlic, hits: res.hits };
        setNewBest(recordLocalBest(score) && res.activeMs > 3000);
        setBest(loadBest());
        setResult(res);
        lastResultRef.current = res;
        setScreen({ name: "results" });
        emit({
          type: "game_over",
          data: { distance: Math.floor(res.distanceM), garlic: res.garlic, hits: res.hits },
        });
        track("game_over", {
          distance: Math.floor(res.distanceM),
          garlic: res.garlic,
          hits: res.hits,
          cause: res.cause,
        });
        track("results_view");
        const run = runRef.current;
        if (run) void submitFinish(run, res);
        else setFinish({ status: "offline" });
        prefetch();
        break;
      }
    }
  });

  // ---------- engine ----------
  const playFromEngine = useEffectEvent(() => play());
  useEffect(() => {
    const canvas = canvasRef.current;
    const frame = frameRef.current;
    if (!boot || !canvas || !frame) return;
    const game = new Game({
      canvas,
      frame,
      hud: {
        spit: spitRef.current!,
        meterFill: meterFillRef.current!,
        distance: distRef.current!,
        distanceValue: distValueRef.current!,
        distanceBar: distBarRef.current!,
        garlic: garlicRef.current!,
        garlicValue: garlicValueRef.current!,
      },
      font,
      translator: createTranslator(document.documentElement.lang === "en" ? "en" : "fr"),
      portrait: boot.portrait,
      reducedMotion: boot.reducedMotion,
      muted: true,
      onEvent: (e) => onGameEvent(e),
      onRequestStart: () => void playFromEngine(),
    });
    gameRef.current = game;
    return () => {
      game.destroy();
      gameRef.current = null;
      setEngineReady(false);
    };
  }, [boot, font]);

  useEffect(() => {
    if (!engineReady) return;
    gameRef.current?.setTranslator(t);
    gameRef.current?.setMuted(muted);
    emit({ type: "ready" });
    track("load", { framed: boot?.framed ?? false });
    // First playable frame: the start screen is up and PLAY works (EMB-11).
    performance.mark("boustan:playable");
    // Engine-ready only: t and muted have their own effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineReady, emit, track]);

  // ---------- host bridge (EMB-03, EMB-05) ----------
  const onCommand = useEffectEvent((command: HostCommand) => {
    const game = gameRef.current;
    if (command.cmd === "setLanguage") setLang(command.lang);
    else if (command.cmd === "pause") game?.pause();
    else if (command.cmd === "resume") game?.resume();
    else if (command.cmd === "mute") setMuted(command.muted);
  });
  useEffect(() => {
    if (!boot) return;
    const bridge = createBridge({
      framed: boot.framed,
      hostOrigin: boot.host,
      patterns,
      onCommand: (c) => onCommand(c),
    });
    bridgeRef.current = bridge;
    return () => bridge.destroy();
  }, [boot, patterns]);

  useEffect(() => {
    if (!boot) return;
    const analytics = createAnalytics({
      enabled: ANALYTICS,
      src: boot.params.src,
      host: boot.host,
      lang: boot.lang,
    });
    analyticsRef.current = analytics;
    return () => {
      analytics.destroy();
      analyticsRef.current = null;
    };
  }, [boot]);

  useEffect(() => {
    if (boot) prefetch();
    // First token only; later ones are fetched after each run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot]);

  // ---------- auto-pause (GAME-09) ----------
  useEffect(() => {
    if (!boot) return;
    const pause = () => gameRef.current?.pause();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") pause();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", pause);
    let io: IntersectionObserver | null = null;
    if (stageRef.current && "IntersectionObserver" in window) {
      io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.intersectionRatio < 0.5)) pause();
        },
        { threshold: [0, 0.25, 0.5] },
      );
      io.observe(stageRef.current);
    }
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", pause);
      io?.disconnect();
    };
  }, [boot]);

  // ---------- size: full-screen gate, host resize events, orientation ----------
  const ar = boot
    ? TUNING.view.width / (boot.portrait ? TUNING.view.heightPortrait : TUNING.view.heightLandscape)
    : null;
  useEffect(() => {
    if (!boot || ar === null) return;
    const measure = () => {
      setTooSmall(
        boot.framed && (window.innerWidth < MIN_EMBED.w || window.innerHeight < MIN_EMBED.h),
      );
      const app = appRef.current;
      const stage = stageRef.current;
      const frame = frameRef.current;
      if (!boot.framed || !app || !stage || !frame) return;
      // Desired height depends on width only, so auto-sizing can't feed back into itself.
      const pad = 2 * parseFloat(getComputedStyle(app).paddingTop);
      const chrome = stage.offsetHeight - frame.offsetHeight;
      const frameW = Math.min(window.innerWidth - pad, 960);
      const height = Math.max(MIN_EMBED.h, Math.ceil(frameW / ar + chrome + pad));
      if (height !== lastHeight.current) {
        lastHeight.current = height;
        emit({ type: "resize", data: { height } });
      }
    };
    measure();
    window.addEventListener("resize", measure);
    void document.fonts?.ready.then(measure);
    return () => window.removeEventListener("resize", measure);
  }, [boot, ar, emit, engineReady]);

  // ---------- test hooks (never in production builds) ----------
  useEffect(() => {
    if (!HOOKS || !engineReady) return;
    const g = () => gameRef.current;
    (window as unknown as { __stc: unknown }).__stc = {
      start: () => playFromEngine(),
      jump: () => g()?.jump(),
      pause: () => g()?.pause(),
      resume: () => g()?.resume(),
      state: () => g()?.state,
      setHeat: (h: number) => g()?.debugSetHeat(h),
      runTime: () => g()?.snapshot().runTime,
      snapshot: () => g()?.snapshot(),
      step: (dt: number) => g()?.debugRun(dt),
      run: (seconds: number) => g()?.debugRun(seconds),
      cheat: (c: { invincible?: boolean; magnet?: boolean }) => g()?.debugCheat(c),
      levelDigest: (seed: number, m: number) => levelDigest(seed, m),
      /** What the last finished run sent to the API (recorded runs for validator tests). */
      result: () => lastResultRef.current,
    };
  }, [engineReady]);

  // ---------- actions ----------
  const playerToken = player?.token;
  const submitClaim: ClaimSubmit = async (input) => {
    if (!boot || !claimCtx) return "claim.errors.expired";
    if (claimCtx.expiresAt < Date.now()) {
      savePending(null);
      return "claim.errors.expired";
    }
    const mode = screen.name === "claim" ? screen.mode : "claim";
    track("claim_submit", { mode, oneTap: input.playerToken !== undefined });
    const failed = (reason: string, key: ClaimErrorKey) => {
      track("claim_error", { reason });
      return key;
    };
    try {
      const res = await boot.api.claim({
        claimToken: claimCtx.claimToken,
        email: input.email,
        playerToken: input.playerToken,
        nickname: input.nickname,
        lang,
        termsAge: input.termsAge,
        marketingOptIn: input.marketingOptIn,
        turnstileToken: input.turnstileToken ?? "",
        src: boot.params.src,
        utm: boot.params.utm,
      });
      track("claim_success", { mode, codes: res.codes.length, already: res.alreadyClaimed.length });
      const emailMasked = input.email ? maskEmail(input.email) : (player?.emailMasked ?? null);
      const saved = { token: res.playerToken, emailMasked: emailMasked ?? "" };
      savePlayer(saved);
      setPlayer(saved);
      addCodes(res.codes);
      setCodes(loadCodes());
      savePending(null);
      setClaimCtx(null);
      const rewards = [...res.codes.map((c) => c.reward), ...res.alreadyClaimed];
      if (rewards.length > 0) emit({ type: "claim_success", data: { rewards } });
      if (mode === "save" || rewards.length + res.unavailable.length === 0) {
        setSavedRank(res.rank);
        setScreen({ name: "results" });
      } else {
        setScreen({
          name: "coupon",
          claim: res,
          emailMasked,
          resendTo: input.email ? { email: input.email } : { playerToken: res.playerToken },
        });
      }
      return null;
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "network";
      switch (code) {
        case "expired":
          savePending(null);
          return failed(code, "claim.errors.expired");
        case "rejected":
          return failed(code, "claim.errors.rejected");
        case "bad_email":
          return failed(code, "claim.errors.badEmail");
        case "rate_limited":
          return failed(code, "claim.errors.tooMany");
        case "unknown_player":
          // The saved token no longer matches a player: forget it and show the form.
          savePlayer(null);
          setPlayer(null);
          return failed(code, "claim.errors.notRecognized");
        default:
          return failed("network", "claim.errors.network");
      }
    }
  };

  const openClaim = (mode: "claim" | "save", back: "start" | "results") => {
    emit({ type: "claim_view" });
    track("claim_view", { mode });
    setScreen({ name: "claim", mode, back });
  };

  const share = async () => {
    if (!result) return;
    track("share_click");
    try {
      const outcome = await shareOrCopy({
        title: t.t("share.title"),
        text: t.plural("share.text", result.garlic, {
          distance: t.num(result.distanceM),
          garlic: t.num(result.garlic),
        }),
        url: shareUrl(window.location.origin),
      });
      if (outcome === "copied") toast(t.t("share.copied"));
    } catch {
      toast(t.t("common.copyFailed"));
    }
  };

  const ui: Ui = useMemo(
    () => ({ t, lang, setLang, muted, toggleMuted, src: boot?.params.src ?? null, emit, toast }),
    [t, lang, setLang, muted, toggleMuted, boot, emit, toast],
  );

  const hudVisible = gameState === "play" || gameState === "paused" || gameState === "countdown";
  const rules = campaign?.rules ?? DEFAULT_REWARD_RULES;
  const style = ar ? ({ "--ar": ar.toFixed(4) } as CSSProperties) : undefined;

  let overlay: ReactNode = null;
  if (boot && tooSmall) {
    overlay = (
      <Overlay labelledBy="gate-title">
        <BrandLogo />
        <p id="gate-title" className="sub">
          {t.t("gate.tooSmall")}
        </p>
        <a
          className="btn primary big"
          href={`/?${attributionQuery(boot.params, lang)}`}
          target="_blank"
          rel="noopener"
          data-autofocus
        >
          {t.t("gate.fullScreen")}
        </a>
      </Overlay>
    );
  } else if (boot) {
    switch (screen.name) {
      case "start":
        overlay = (
          <StartScreen
            campaign={campaign}
            starting={starting || !engineReady}
            hasRewards={codes.length > 0}
            hasPending={claimCtx !== null && claimCtx.unlocked.length > 0}
            onPlay={() => void play()}
            onLeaderboard={() => setScreen({ name: "leaderboard", back: "start" })}
            onMyRewards={() => setScreen({ name: "rewards", back: "start" })}
            onClaimPending={() => openClaim("claim", "start")}
          />
        );
        break;
      case "results":
        overlay = result && (
          <ResultsScreen
            result={result}
            finish={finish}
            campaign={campaign}
            best={best}
            newBest={newBest}
            preview={preview}
            savedRank={savedRank}
            onClaim={(mode) => openClaim(mode, "results")}
            onRetryFinish={() => runRef.current && void submitFinish(runRef.current, result)}
            onPlayAgain={() => void play()}
            onShare={() => void share()}
            onLeaderboard={() => setScreen({ name: "leaderboard", back: "results" })}
          />
        );
        break;
      case "claim":
        overlay = (
          <ClaimScreen
            mode={screen.mode}
            rewards={claimCtx?.unlocked ?? []}
            rules={rules}
            player={player}
            onSubmit={submitClaim}
            onBack={() => setScreen(backTo(screen.back))}
          />
        );
        break;
      case "coupon":
        overlay = (
          <CouponScreen
            codes={screen.claim.codes}
            alreadyClaimed={screen.claim.alreadyClaimed}
            unavailable={screen.claim.unavailable}
            emailMasked={screen.emailMasked}
            onResend={() =>
              boot.api.resend(screen.resendTo).then(
                () => true,
                () => false,
              )
            }
            onPlayAgain={() => void play()}
          />
        );
        break;
      case "leaderboard":
        overlay = (
          <LeaderboardScreen
            api={boot.api}
            playerToken={playerToken}
            onBack={() => setScreen(backTo(screen.back))}
          />
        );
        break;
      case "rewards":
        overlay = <MyRewardsScreen codes={codes} onBack={() => setScreen(backTo(screen.back))} />;
        break;
    }
  }

  return (
    <UiContext.Provider value={ui}>
      <div className="app" ref={appRef} style={style}>
        <div className="stage" ref={stageRef}>
          <header className="bar">
            <div className="bar-brand">
              {boot && <BrandLogo small />}
              <span className="bar-title">{t.t("brand.game")}</span>
            </div>
            {boot && <Tools />}
          </header>
          <div
            className="frame"
            ref={frameRef}
            tabIndex={-1}
            role="group"
            aria-label={t.t("meta.gameLabel")}
          >
            <canvas ref={canvasRef} width={320} height={180} aria-hidden="true" />
            <div className={hudVisible ? "hud" : "hud hidden"}>
              <div className="hud-left" aria-hidden="true">
                <div className="spit" ref={spitRef}>
                  <span className="spit-label">{t.t("hud.spit")}</span>
                  <span className="hot-label">{t.t("hud.hot")}</span>
                  <div className="meter">
                    <i ref={meterFillRef} />
                  </div>
                </div>
              </div>
              <div className="hud-right">
                <div className="goal" ref={distRef} aria-hidden="true">
                  <PixelIcon name="can" />
                  <span className="goal-bar">
                    <i ref={distBarRef} />
                  </span>
                  <CheckIcon className="check" />
                  <span ref={distValueRef} data-testid="hud-distance" />
                </div>
                <div className="goal" ref={garlicRef} aria-hidden="true">
                  <PixelIcon name="cup" />
                  <CheckIcon className="check" />
                  <span ref={garlicValueRef} data-testid="hud-garlic" />
                </div>
                <button
                  type="button"
                  className="hud-pause"
                  aria-label={t.t("hud.pause")}
                  onClick={() => gameRef.current?.pause()}
                >
                  <PauseIcon />
                </button>
              </div>
            </div>
            {gameState === "paused" && (
              <div className="paused">
                <h2>{t.t("pause.title")}</h2>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => gameRef.current?.resume()}
                  autoFocus
                >
                  {t.t("pause.resume")}
                </button>
                <p>{t.t("pause.hint")}</p>
              </div>
            )}
          </div>
          <p className="hint">{t.t("hud.hint")}</p>
        </div>
      </div>
      {overlay}
      <div className="sr-only" aria-live="polite" data-testid="announce">
        {announce}
      </div>
      {toastText && (
        <div className="toast" role="status">
          {toastText}
        </div>
      )}
    </UiContext.Provider>
  );
}
