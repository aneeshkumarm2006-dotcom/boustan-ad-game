/**
 * Page context read once at load: query parameters (PRD EMB-02), whether the game is framed,
 * and the host's origin. Unknown parameters are ignored; known ones are kept for attribution
 * and sent with each run and saved score (AN-04).
 */

export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content"] as const;
export type UtmKey = (typeof UTM_KEYS)[number];
export type Utm = Partial<Record<UtmKey, string>>;

export interface LaunchParams {
  lang: string | null;
  /** Placement ID, e.g. a partner code or "share". */
  src: string | null;
  utm: Utm;
  /** `?muted=1` or `?muted=0`; null when absent. */
  muted: boolean | null;
}

/** Placement IDs and UTM values: short, printable, no markup. */
const SAFE_VALUE = /^[\p{L}\p{N} ._~:/@+-]{1,100}$/u;

function clean(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return SAFE_VALUE.test(trimmed) ? trimmed : null;
}

export function parseLaunchParams(search: string): LaunchParams {
  const params = new URLSearchParams(search);
  const utm: Utm = {};
  for (const key of UTM_KEYS) {
    const value = clean(params.get(key));
    if (value) utm[key] = value;
  }
  const muted = params.get("muted");
  return {
    lang: params.get("lang"),
    src: clean(params.get("src")),
    utm,
    muted: muted === "1" ? true : muted === "0" ? false : null,
  };
}

/** Query string that carries the attribution parameters on to another page of the game. */
export function attributionQuery(params: LaunchParams, lang: string): string {
  const out = new URLSearchParams({ lang });
  if (params.src) out.set("src", params.src);
  for (const key of UTM_KEYS) {
    const value = params.utm[key];
    if (value) out.set(key, value);
  }
  return out.toString();
}

export function isFramed(win: Window = window): boolean {
  try {
    return win.self !== win.top;
  } catch {
    return true; // cross-origin top: certainly framed
  }
}

/**
 * Origin of the embedding page, or null when standalone or unknown. Chromium and WebKit expose
 * `location.ancestorOrigins`; Firefox falls back to the referrer, which hosts can strip.
 */
export function hostOrigin(win: Window = window): string | null {
  if (!isFramed(win)) return null;
  const ancestors = win.location.ancestorOrigins;
  if (ancestors && ancestors.length > 0) return ancestors[0];
  try {
    return win.document.referrer ? new URL(win.document.referrer).origin : null;
  } catch {
    return null;
  }
}
