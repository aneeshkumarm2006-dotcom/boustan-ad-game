import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("public/embed.js (EMB-04)", () => {
  const source = readFileSync(path.join(__dirname, "../../public/embed.js"), "utf8");

  it("stays at 3 KB or less", () => {
    expect(Buffer.byteLength(source)).toBeLessThanOrEqual(3 * 1024);
  });

  it("checks event.origin and pushes boustan_game_* events to dataLayer", () => {
    expect(source).toContain("e.origin !== origin");
    expect(source).toContain('"boustan_game_" + d.type');
  });
});
