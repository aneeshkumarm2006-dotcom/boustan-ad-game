"use client";

/**
 * Cloudflare Turnstile on the claim form (SEC-05). The script is the only third-party code the
 * game loads, and only once the claim form opens (EMB-11). Tokens are single use, so the form
 * resets the widget after every submit. Off in mock mode and when no site key is set.
 */
import { useCallback, useEffect, useRef, type RefObject } from "react";

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";
export const TURNSTILE_ENABLED = process.env.NEXT_PUBLIC_API_MODE === "live" && SITE_KEY !== "";

/** Give up waiting for a token after this long; the server then refuses the claim. */
const WAIT_MS = 10_000;

interface TurnstileApi {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

function loadScript(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile"));
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error("turnstile"));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/** Renders the widget into `box` (an element the form always mounts while Turnstile is on). */
export function useTurnstile(box: RefObject<HTMLDivElement | null>, lang: string) {
  const widget = useRef<string | null>(null);
  const token = useRef<string | null>(null);
  const waiting = useRef<((value: string) => void)[]>([]);
  const langRef = useRef(lang);

  const settle = (value: string) => {
    const list = waiting.current;
    waiting.current = [];
    list.forEach((resolve) => resolve(value));
  };

  useEffect(() => {
    const el = box.current;
    if (!TURNSTILE_ENABLED || !el) return;
    let live = true;
    loadScript().then(
      (ts) => {
        if (!live) return;
        widget.current = ts.render(el, {
          sitekey: SITE_KEY,
          language: langRef.current,
          appearance: "interaction-only",
          size: "flexible",
          "refresh-expired": "auto",
          callback: (value: string) => {
            token.current = value;
            settle(value);
          },
          "expired-callback": () => {
            token.current = null;
          },
          "error-callback": () => settle(""),
        });
      },
      () => settle(""),
    );
    return () => {
      live = false;
      if (widget.current) window.turnstile?.remove(widget.current);
      widget.current = null;
      settle("");
    };
  }, [box]);

  /** A fresh token, or "" when Turnstile is off or didn't answer in time. */
  const getToken = useCallback((): Promise<string> => {
    if (!TURNSTILE_ENABLED) return Promise.resolve("");
    if (token.current) return Promise.resolve(token.current);
    return new Promise((resolve) => {
      waiting.current.push(resolve);
      setTimeout(() => resolve(""), WAIT_MS);
    });
  }, []);

  /** Tokens work once: call after each submit. */
  const reset = useCallback(() => {
    token.current = null;
    if (widget.current) window.turnstile?.reset(widget.current);
  }, []);

  return { getToken, reset };
}
