/**
 * ALLOWED_HOSTS: which sites may embed the game (PRD EMB-06) and send it commands (EMB-05).
 *
 * The variable is a comma-separated list of CSP host sources: `https://www.boustan.ca`,
 * `https://*.partner.com` (subdomains only), `http://localhost:*` (any port). The same list
 * builds the `frame-ancestors` header and checks `event.origin` on host commands, so the two
 * always agree. Anything that isn't a clean scheme://host[:port] is dropped, which also keeps
 * stray characters out of the header.
 */

export interface HostPattern {
  scheme: "http" | "https";
  /** Lowercase host; starts with "*." for a subdomain wildcard. */
  host: string;
  /** "*" for any port, a number string, or null for the scheme's default port. */
  port: string | null;
  /** The source as written in the CSP header. */
  source: string;
}

const PATTERN =
  /^(https?):\/\/(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:]+\])(?::(\*|\d{1,5}))?\/?$/i;

export function parseAllowedHosts(value: string | undefined | null): {
  patterns: HostPattern[];
  rejected: string[];
} {
  const patterns: HostPattern[] = [];
  const rejected: string[] = [];
  for (const raw of (value ?? "").split(",")) {
    const entry = raw.trim();
    if (entry === "") continue;
    const match = PATTERN.exec(entry);
    if (!match) {
      rejected.push(entry);
      continue;
    }
    const [, scheme, wildcard, hostname, port] = match;
    const host = `${wildcard ?? ""}${hostname}`.toLowerCase();
    const s = scheme.toLowerCase() as HostPattern["scheme"];
    patterns.push({
      scheme: s,
      host,
      port: port ?? null,
      source: `${s}://${host}${port ? `:${port}` : ""}`,
    });
  }
  return { patterns, rejected };
}

/** `Content-Security-Policy` value. 'self' is always allowed, so the app can frame itself. */
export function frameAncestors(patterns: readonly HostPattern[]): string {
  return ["frame-ancestors", "'self'", ...patterns.map((p) => p.source)].join(" ");
}

const DEFAULT_PORT = { http: "80", https: "443" } as const;

/** Whether an origin such as "https://news.example.com" matches one of the patterns. */
export function isAllowedOrigin(origin: string, patterns: readonly HostPattern[]): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const scheme = url.protocol.replace(/:$/, "");
  if (scheme !== "http" && scheme !== "https") return false;
  const host = url.hostname.toLowerCase();
  const port = url.port || DEFAULT_PORT[scheme];
  return patterns.some((p) => {
    if (p.scheme !== scheme) return false;
    const hostOk = p.host.startsWith("*.") ? host.endsWith(p.host.slice(1)) : host === p.host;
    if (!hostOk) return false;
    if (p.port === "*") return true;
    return (p.port ?? DEFAULT_PORT[p.scheme]) === port;
  });
}
