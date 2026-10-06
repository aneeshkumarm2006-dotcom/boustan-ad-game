/**
 * First-party analytics (AN-01, AN-02): no cookies, no third parties, a session ID that only
 * lives in memory. Events are batched and posted to /api/events; when the page is hidden the
 * batch goes with sendBeacon so it survives the tab closing. Never put personal data in props.
 */
import type { ClientEvent, EventProps } from "./analytics-events";

const FLUSH_MS = 5000;
const MAX_BATCH = 20;
const ENDPOINT = "/api/events";

export interface Analytics {
  track(name: ClientEvent, props?: EventProps): void;
  setLang(lang: string): void;
  destroy(): void;
}

const NOOP: Analytics = { track() {}, setLang() {}, destroy() {} };

export function createAnalytics(opts: {
  enabled: boolean;
  src: string | null;
  host: string | null;
  lang: string;
}): Analytics {
  if (!opts.enabled || typeof window === "undefined") return NOOP;
  const sessionId = crypto.randomUUID();
  let lang = opts.lang;
  let queue: { name: ClientEvent; props?: EventProps }[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  function flush(beacon = false) {
    clearTimeout(timer);
    timer = undefined;
    while (queue.length > 0) {
      const events = queue.slice(0, 50);
      queue = queue.slice(50);
      // A string body is sent as text/plain: no CORS preflight, and sendBeacon accepts it.
      const body = JSON.stringify({ sessionId, src: opts.src, lang, host: opts.host, events });
      if (beacon && navigator.sendBeacon?.(ENDPOINT, body)) continue;
      void fetch(ENDPOINT, { method: "POST", body, keepalive: true, credentials: "omit" }).catch(
        () => {},
      );
    }
  }

  const onHidden = () => {
    if (document.visibilityState === "hidden") flush(true);
  };
  const onPageHide = () => flush(true);
  document.addEventListener("visibilitychange", onHidden);
  window.addEventListener("pagehide", onPageHide);

  return {
    track(name, props) {
      queue.push(props ? { name, props } : { name });
      if (queue.length >= MAX_BATCH) flush();
      else timer ??= setTimeout(() => flush(), FLUSH_MS);
    },
    setLang(next) {
      if (next === lang) return;
      flush();
      lang = next;
    },
    destroy() {
      flush(true);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
    },
  };
}
