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
import { TUNING, WINNERS, levelDigest, randomSeed, type RunScore } from "@/game-core";
import { createTranslator, pickLanguage, type Lang } from "@/i18n";
import {
  ApiError,
  createApi,
  type CampaignState,
  type GameApi,
  type LeaderboardResponse,
  type StartRunResponse,
} from "@/lib/api";
import type { HostPattern } from "@/lib/embed/allowed-hosts";
import { createAnalytics, type Analytics } from "@/lib/analytics";
import type { ClientEvent, EventProps } from "@/lib/analytics-events";
import { createBridge, type Bridge, type HostCommand, type HostEvent } from "@/lib/embed/bridge";
import { shareUrl } from "@/lib/links";
import { loadBest, loadPlayer, recordLocalBest, savePlayer, type SavedPlayer } from "@/lib/player";
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
import type { CanvasFonts } from "../fonts";
import { UiContext, type Ui } from "./context";
import { LeaderboardScreen } from "./LeaderboardScreen";
import { BrandLogo, Overlay, PauseIcon, PixelIcon, SparkIcon, Tools } from "./parts";
import { ResultsScreen, type FinishState } from "./ResultsScreen";
import { SavedScreen } from "./SavedScreen";
import { type SaveErrorKey, type SaveSubmit } from "./SaveScreen";
import { shareOrCopy } from "./share";
import { StartScreen } from "./StartScreen";

/** Where the leaderboard's BACK goes. */
type From = "start" | "results" | "saved";

type Screen =
  | { name: "start" }
  | { name: "play" }
  | { name: "results" }
  | { name: "saved" }
  | { name: "leaderboard"; back: From };

/** The finished run's save token, while the save form can use it (SEC-04). */
interface SaveCtx {
  token: string;
  points: number;
  expiresAt: number;
}

/** What the save form put on the board, for the "saved" screen. */
interface SavedScore {
  rank: number | null;
  points: number;
}

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
}

/** Viewport narrower than this ratio gets the taller canvas (reference behaviour). */
const PORTRAIT_QUERY = `(max-aspect-ratio: 20/23)`;
/** EMB-01: below this, an iframe shows "Play full screen" instead of the game. */
const MIN_EMBED = { w: 300, h: 400 };
const RUN_START_WAIT_MS = 1200;
/** A score can be saved for this long after the run (SEC-04). */
const SAVE_WINDOW_MS = 30 * 60 * 1000;
/** Test hooks: set in next.config.ts, never on in production deployments. */
const HOOKS = process.env.STC_HOOKS === "1";
/** First-party analytics only talk to the real API (AN-01). */
const ANALYTICS = process.env.NEXT_PUBLIC_API_MODE === "live";

const backTo = (from: From): Screen => ({ name: from });

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

export function GameApp({ fonts, patterns }: { fonts: CanvasFonts; patterns: HostPattern[] }) {
  const { display, condensed } = fonts;
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
  const [preview, setPreview] = useState<LeaderboardResponse | null>(null);
  const [saveCtx, setSaveCtx] = useState<SaveCtx | null>(null);
  const [saved, setSaved] = useState<SavedScore | null>(null);
  const [player, setPlayer] = useStateFrom<SavedPlayer | null>(boot?.player ?? null);
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
  const pointsRef = useRef<HTMLSpanElement>(null);
  const garlicRef = useRef<HTMLSpanElement>(null);
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
      if (event.type === "save_view") track("save_view");
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
    runRef.current = run;
    setResult(null);
    setPreview(null);
    setSaveCtx(null);
    setSaved(null);
    setNewBest(false);
    game.start({ seed: run?.seed ?? randomSeed() });
    setScreen({ name: "play" });
    emit({ type: "game_start" });
    track("start", { online: run !== null });
    frameRef.current?.focus({ preventScroll: true });
  }, [obtainRun, emit, track]);

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
        if (!out.valid) return;
        if (out.saveToken) {
          setSaveCtx({
            token: out.saveToken,
            points: out.points,
            expiresAt: Date.now() + SAVE_WINDOW_MS,
          });
        }
        boot.api.leaderboard(WINNERS, loadPlayer()?.token).then(
          (lb) => setPreview(lb),
          () => setPreview(null),
        );
      } catch {
        setFinish({ status: "error" });
      }
    },
    [boot],
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
        emit({ type: "milestone", data: { points: event.points } });
        track("milestone", { points: event.points });
        break;
      case "over": {
        const res = event.result;
        const score = { points: res.points, distanceM: res.distanceM, garlic: res.garlic };
        setNewBest(recordLocalBest(score) && res.activeMs > 3000);
        setBest(loadBest());
        setResult(res);
        lastResultRef.current = res;
        setScreen({ name: "results" });
        const distance = Math.floor(res.distanceM);
        emit({ type: "game_over", data: { points: res.points, distance, garlic: res.garlic } });
        track("game_over", {
          points: res.points,
          distance,
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
        points: pointsRef.current!,
        garlic: garlicRef.current!,
      },
      fonts: { display, condensed },
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
  }, [boot, display, condensed]);

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
  const submitSave: SaveSubmit = async (input) => {
    if (!boot || !saveCtx) return "save.errors.expired";
    const failed = (reason: string, key: SaveErrorKey) => {
      track("save_error", { reason });
      return key;
    };
    if (saveCtx.expiresAt < Date.now()) return failed("expired", "save.errors.expired");
    track("save_submit");
    try {
      const res = await boot.api.saveScore({
        saveToken: saveCtx.token,
        email: input.email,
        nickname: input.nickname,
        lang,
        termsAge: input.termsAge,
        marketingOptIn: input.marketingOptIn,
        turnstileToken: input.turnstileToken,
        src: boot.params.src,
        utm: boot.params.utm,
      });
      track("save_success");
      const me = { token: res.playerToken };
      savePlayer(me);
      setPlayer(me);
      setSaveCtx(null);
      // The board shows the player's best, which may be an earlier run on another device.
      setSaved({ rank: res.rank, points: res.best?.points ?? saveCtx.points });
      emit({ type: "score_saved", data: { rank: res.rank } });
      setScreen({ name: "saved" });
      return null;
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "network";
      switch (code) {
        case "expired":
          return failed(code, "save.errors.expired");
        case "rejected":
          return failed(code, "save.errors.rejected");
        case "bad_email":
          return failed(code, "save.errors.badEmail");
        case "rate_limited":
          return failed(code, "save.errors.tooMany");
        case "closed":
          return failed(code, "save.errors.closed");
        default:
          return failed("network", "save.errors.network");
      }
    }
  };

  const share = async () => {
    if (!result) return;
    track("share_click");
    try {
      const outcome = await shareOrCopy({
        title: t.t("share.title"),
        text: t.plural("share.text", result.garlic, {
          points: t.num(result.points),
          distance: t.num(result.distanceM),
          garlic: t.num(result.garlic),
          n: WINNERS,
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
  const style = ar ? ({ "--ar": ar.toFixed(4) } as CSSProperties) : undefined;
  const showBoard = (back: From) => setScreen({ name: "leaderboard", back });

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
            onPlay={() => void play()}
            onLeaderboard={() => showBoard("start")}
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
            onSubmit={submitSave}
            onRetryFinish={() => runRef.current && void submitFinish(runRef.current, result)}
            onPlayAgain={() => void play()}
            onShare={() => void share()}
            onLeaderboard={() => showBoard("results")}
          />
        );
        break;
      case "saved":
        overlay = saved && (
          <SavedScreen
            rank={saved.rank}
            points={saved.points}
            campaign={campaign}
            onPlayAgain={() => void play()}
            onLeaderboard={() => showBoard("saved")}
          />
        );
        break;
      case "leaderboard":
        overlay = (
          <LeaderboardScreen
            api={boot.api}
            playerToken={player?.token}
            campaign={campaign}
            onBack={() => setScreen(backTo(screen.back))}
          />
        );
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
                <div className="chip" aria-hidden="true">
                  <SparkIcon className="chip-spark" />
                  <span ref={pointsRef} data-testid="hud-points" />
                  <span className="chip-unit">{t.t("hud.points")}</span>
                </div>
                <div className="chip" aria-hidden="true">
                  <PixelIcon name="cup" />
                  <span ref={garlicRef} data-testid="hud-garlic" />
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
      {toastText && (
        <div className="toast" role="status">
          {toastText}
        </div>
      )}
    </UiContext.Provider>
  );
}
