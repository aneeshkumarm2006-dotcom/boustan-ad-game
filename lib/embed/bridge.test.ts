import { afterEach, describe, expect, it, vi } from "vitest";
import { createBridge, parseCommand } from "./bridge";

const msg = (extra: Record<string, unknown>) => ({ ns: "boustan-game", v: 1, ...extra });

describe("parseCommand (EMB-05)", () => {
  it("accepts the four commands", () => {
    expect(parseCommand(msg({ cmd: "setLanguage", value: "en" }))).toEqual({
      cmd: "setLanguage",
      lang: "en",
    });
    expect(parseCommand(msg({ cmd: "pause" }))).toEqual({ cmd: "pause" });
    expect(parseCommand(msg({ cmd: "resume" }))).toEqual({ cmd: "resume" });
    expect(parseCommand(msg({ cmd: "mute" }))).toEqual({ cmd: "mute", muted: true });
    expect(parseCommand(msg({ cmd: "mute", value: false }))).toEqual({ cmd: "mute", muted: false });
  });

  it("rejects other namespaces, versions, commands and bad values", () => {
    expect(parseCommand({ ns: "other", v: 1, cmd: "pause" })).toBeNull();
    expect(parseCommand(msg({ v: 2, cmd: "pause" }))).toBeNull();
    expect(parseCommand(msg({ cmd: "start" }))).toBeNull();
    expect(parseCommand(msg({ cmd: "setLanguage", value: "de" }))).toBeNull();
    expect(parseCommand("pause")).toBeNull();
    expect(parseCommand(null)).toBeNull();
  });
});

describe("createBridge events (EMB-03)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A framed game whose parent records what it is sent. */
  function framed(hostOrigin: string | null) {
    const posted: [unknown, string][] = [];
    const parent = {
      postMessage: (message: unknown, target: string) => posted.push([message, target]),
    };
    vi.stubGlobal("window", { parent, addEventListener() {}, removeEventListener() {} });
    const bridge = createBridge({ framed: true, hostOrigin, patterns: [], onCommand() {} });
    return { bridge, posted };
  }

  it("posts the points, distance and garlic at game over, then the saved rank", () => {
    const { bridge, posted } = framed("https://www.lapresse.ca");
    bridge.emit({ type: "game_over", data: { points: 482, distance: 312, garlic: 17 } });
    bridge.emit({ type: "save_view" });
    bridge.emit({ type: "score_saved", data: { rank: 4 } });
    expect(posted).toEqual([
      [
        msg({ type: "game_over", data: { points: 482, distance: 312, garlic: 17 } }),
        "https://www.lapresse.ca",
      ],
      [msg({ type: "save_view", data: {} }), "https://www.lapresse.ca"],
      [msg({ type: "score_saved", data: { rank: 4 } }), "https://www.lapresse.ca"],
    ]);
  });

  it("sends to any origin when the host's is unknown, since events carry nothing personal", () => {
    const { bridge, posted } = framed(null);
    bridge.emit({ type: "milestone", data: { points: 100 } });
    expect(posted).toEqual([[msg({ type: "milestone", data: { points: 100 } }), "*"]]);
  });

  it("stays silent outside an iframe", () => {
    const postMessage = vi.fn();
    vi.stubGlobal("window", { parent: { postMessage } });
    createBridge({ framed: false, hostOrigin: null, patterns: [], onCommand() {} }).emit({
      type: "ready",
    });
    expect(postMessage).not.toHaveBeenCalled();
  });
});
