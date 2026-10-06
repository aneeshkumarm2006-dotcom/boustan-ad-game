import { describe, expect, it } from "vitest";
import { frameAncestors, isAllowedOrigin, parseAllowedHosts } from "./allowed-hosts";

describe("parseAllowedHosts", () => {
  it("parses the documented forms", () => {
    const { patterns, rejected } = parseAllowedHosts(
      " https://www.boustan.ca, https://*.Partner.com ,http://localhost:*,http://127.0.0.1:3200/",
    );
    expect(rejected).toEqual([]);
    expect(patterns.map((p) => p.source)).toEqual([
      "https://www.boustan.ca",
      "https://*.partner.com",
      "http://localhost:*",
      "http://127.0.0.1:3200",
    ]);
  });

  it("drops anything that could break or widen the header", () => {
    const { patterns, rejected } = parseAllowedHosts(
      "*, https://ok.ca, https://a.ca; script-src *, 'unsafe-inline', ftp://x.ca, https://x.ca/path, https://*",
    );
    expect(patterns.map((p) => p.source)).toEqual(["https://ok.ca"]);
    expect(rejected).toHaveLength(6);
  });

  it("handles an empty or missing value", () => {
    expect(parseAllowedHosts(undefined).patterns).toEqual([]);
    expect(parseAllowedHosts(" , ").patterns).toEqual([]);
  });
});

describe("frameAncestors", () => {
  it("always allows 'self'", () => {
    expect(frameAncestors([])).toBe("frame-ancestors 'self'");
    const { patterns } = parseAllowedHosts("https://a.ca,http://localhost:*");
    expect(frameAncestors(patterns)).toBe("frame-ancestors 'self' https://a.ca http://localhost:*");
  });
});

describe("isAllowedOrigin", () => {
  const { patterns } = parseAllowedHosts(
    "https://www.boustan.ca,https://*.partner.com,http://localhost:*,http://127.0.0.1:3200",
  );

  it("matches exact hosts on the default port", () => {
    expect(isAllowedOrigin("https://www.boustan.ca", patterns)).toBe(true);
    expect(isAllowedOrigin("https://www.boustan.ca:443", patterns)).toBe(true);
    expect(isAllowedOrigin("https://www.boustan.ca:8443", patterns)).toBe(false);
    expect(isAllowedOrigin("http://www.boustan.ca", patterns)).toBe(false);
    expect(isAllowedOrigin("https://boustan.ca", patterns)).toBe(false);
  });

  it("matches subdomain wildcards but not the bare domain or lookalikes", () => {
    expect(isAllowedOrigin("https://news.partner.com", patterns)).toBe(true);
    expect(isAllowedOrigin("https://a.b.partner.com", patterns)).toBe(true);
    expect(isAllowedOrigin("https://partner.com", patterns)).toBe(false);
    expect(isAllowedOrigin("https://evilpartner.com", patterns)).toBe(false);
  });

  it("matches port wildcards and exact ports", () => {
    expect(isAllowedOrigin("http://localhost:3000", patterns)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:3200", patterns)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:3201", patterns)).toBe(false);
  });

  it("rejects junk", () => {
    expect(isAllowedOrigin("null", patterns)).toBe(false);
    expect(isAllowedOrigin("", patterns)).toBe(false);
    expect(isAllowedOrigin("file:///tmp/x.html", patterns)).toBe(false);
  });
});
