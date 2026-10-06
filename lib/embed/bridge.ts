/**
 * postMessage bridge to the host page (PRD EMB-03, EMB-05).
 *
 * Game → host: `{ ns: "boustan-game", v: 1, type, data }`. Events never carry an email, a code
 * or anything else personal. Host → game: `{ ns: "boustan-game", v: 1, cmd, value? }`, accepted
 * only from the parent window and only from an origin in ALLOWED_HOSTS.
 */
import type { RewardId } from "@/game-core";
import { isLang, type Lang } from "@/i18n";
import { isAllowedOrigin, type HostPattern } from "./allowed-hosts";

export const NS = "boustan-game";
export const VERSION = 1;

export type HostEvent =
  | { type: "ready" }
  | { type: "game_start" }
  | { type: "milestone"; data: { m: number } }
  | { type: "reward_unlocked"; data: { reward: RewardId } }
  | { type: "game_over"; data: { distance: number; garlic: number; hits: number } }
  | { type: "claim_view" }
  | { type: "claim_success"; data: { rewards: RewardId[] } }
  | { type: "leaderboard_view" }
  | { type: "cta_click"; data: { target: string } }
  | { type: "resize"; data: { height: number } };

export type HostCommand =
  | { cmd: "setLanguage"; lang: Lang }
  | { cmd: "pause" }
  | { cmd: "resume" }
  | { cmd: "mute"; muted: boolean };

/** Parses a host message into a command, or null if it isn't one of ours. */
export function parseCommand(data: unknown): HostCommand | null {
  if (typeof data !== "object" || data === null) return null;
  const msg = data as Record<string, unknown>;
  if (msg.ns !== NS || msg.v !== VERSION) return null;
  switch (msg.cmd) {
    case "setLanguage":
      return isLang(msg.value) ? { cmd: "setLanguage", lang: msg.value } : null;
    case "pause":
    case "resume":
      return { cmd: msg.cmd };
    case "mute":
      return { cmd: "mute", muted: msg.value !== false };
    default:
      return null;
  }
}

export interface Bridge {
  emit(event: HostEvent): void;
  destroy(): void;
}

export function createBridge(options: {
  framed: boolean;
  hostOrigin: string | null;
  patterns: readonly HostPattern[];
  onCommand: (command: HostCommand) => void;
}): Bridge {
  const { framed, hostOrigin, patterns, onCommand } = options;
  if (!framed) return { emit() {}, destroy() {} };

  // Events carry no personal data, so "*" is safe when the host origin is unknown.
  const target = hostOrigin ?? "*";
  const onMessage = (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    if (!isAllowedOrigin(event.origin, patterns)) return;
    const command = parseCommand(event.data);
    if (command) onCommand(command);
  };
  window.addEventListener("message", onMessage);

  return {
    emit(event) {
      const data = "data" in event ? event.data : {};
      try {
        window.parent.postMessage({ ns: NS, v: VERSION, type: event.type, data }, target);
      } catch {
        // A wrong target origin throws in some browsers; the event is just dropped.
      }
    },
    destroy() {
      window.removeEventListener("message", onMessage);
    },
  };
}
