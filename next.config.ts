import type { NextConfig } from "next";
import { frameAncestors, parseAllowedHosts } from "./lib/embed/allowed-hosts";

// EMB-06: only ALLOWED_HOSTS may frame the game. Read at build time, like every Vercel env var.
const { patterns, rejected } = parseAllowedHosts(process.env.ALLOWED_HOSTS);
if (rejected.length > 0) {
  console.warn(`ALLOWED_HOSTS: ignored invalid entries: ${rejected.join(", ")}`);
}

// window.__stc test hooks: on in dev and Vercel previews, off in production builds unless
// STC_TEST_HOOKS=1 (end-to-end tests against a local production build).
const hooks = process.env.STC_TEST_HOOKS
  ? process.env.STC_TEST_HOOKS === "1"
  : process.env.NODE_ENV !== "production" || process.env.VERCEL_ENV === "preview";

const dev = process.env.NODE_ENV === "development";
const TURNSTILE = "https://challenges.cloudflare.com";

/**
 * Game page CSP (SEC-09). Everything is same-origin except Turnstile on the claim form
 * (EMB-11). Scripts keep 'unsafe-inline': the page is static, and Next's inline bootstrap
 * scripts can only carry a nonce on a page rendered per request (DECISIONS.md).
 */
const pageCsp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' ${TURNSTILE}${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  `frame-src ${TURNSTILE}`,
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  frameAncestors(patterns),
  // Deployed sites are HTTPS only; local production builds serve plain http.
  ...(process.env.VERCEL ? ["upgrade-insecure-requests"] : []),
].join("; ");

/**
 * /admin: same-origin only and never framed (the game's frame-ancestors list is for embedding
 * the game, not the admin). Scripts keep 'unsafe-inline' for Next's bootstrap, as on the game.
 */
const adminCsp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(process.env.VERCEL ? ["upgrade-insecure-requests"] : []),
].join("; ");

/** JSON endpoints render nothing. */
const apiCsp = "default-src 'none'; frame-ancestors 'none'";

const security = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  env: {
    STC_HOOKS: hooks ? "1" : "0",
    // Sent with every API call and stored on runs (Stage 2.2).
    NEXT_PUBLIC_CLIENT_VERSION: (process.env.VERCEL_GIT_COMMIT_SHA ?? "dev").slice(0, 12),
  },
  poweredByHeader: false,
  // Code-pool CSV uploads go through a server action; the app caps files at 5 MB.
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
  async headers() {
    // A CSP set here wins over one a route sets itself, so each path gets exactly one: the
    // game's, the JSON API's, or (unsubscribe and the email view) the route's own.
    return [
      { source: "/:path*", headers: security },
      {
        source: "/((?!api/|admin).*)",
        headers: [{ key: "Content-Security-Policy", value: pageCsp }],
      },
      {
        source: "/admin/:path*",
        headers: [
          { key: "Content-Security-Policy", value: adminCsp },
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
      {
        source: "/api/:path((?!unsubscribe|email/view).*)",
        headers: [{ key: "Content-Security-Policy", value: apiCsp }],
      },
    ];
  },
};

export default nextConfig;
