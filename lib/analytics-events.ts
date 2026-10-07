/**
 * Analytics event names (AN-01), shared by the client batcher and the /api/events check.
 * Client events come from the game; server events are written by the API itself.
 */
export const CLIENT_EVENTS = [
  "load",
  "start",
  "milestone",
  "game_over",
  "results_view",
  "save_view",
  "save_submit",
  "save_success",
  "save_error",
  "leaderboard_view",
  "share_click",
  "cta_click",
  "language_switch",
  "pause",
] as const;
export type ClientEvent = (typeof CLIENT_EVENTS)[number];

export const SERVER_EVENTS = ["opt_in", "api_save"] as const;
export type ServerEvent = (typeof SERVER_EVENTS)[number];

export type EventProps = Record<string, string | number | boolean>;
