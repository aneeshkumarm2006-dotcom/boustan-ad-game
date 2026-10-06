import { describe, expect, it } from "vitest";
import { levelFor, percentLeft } from "./stock-alerts";
import { parseCodesCsv, parseEmailList, parseThresholds } from "./pools";

describe("parseCodesCsv (RWD-02)", () => {
  it("reads a bare list of codes, trimming and de-duplicating", () => {
    const r = parseCodesCsv("  AAA-111 \nBBB-222\nAAA-111\n\nCCC-333\n");
    expect(r.valid.map((c) => c.code)).toEqual(["AAA-111", "BBB-222", "CCC-333"]);
    expect(r.rows).toBe(4);
    expect(r.duplicatesInFile).toBe(1);
    expect(r.invalid).toEqual([]);
  });

  it("finds columns by header name, with optional expires_at and batch", () => {
    const r = parseCodesCsv(
      "batch,code,expires_at\nuEat-1,AAA-111,2026-11-15\nuEat-1,BBB-222,2026-11-15T12:30\n,CCC-333,\n",
    );
    expect(r.valid).toHaveLength(3);
    // A bare date runs to the end of that day, Montréal time.
    expect(r.valid[0].expiresAt?.toISOString()).toBe("2026-11-16T04:59:00.000Z");
    expect(r.valid[1].expiresAt?.toISOString()).toBe("2026-11-15T17:30:00.000Z");
    expect(r.valid[2].expiresAt).toBeNull();
    expect(r.valid.map((c) => c.batch)).toEqual(["uEat-1", "uEat-1", null]);
  });

  it("reports unusable rows with their line and reason, and keeps the rest", () => {
    const r = parseCodesCsv(
      "code,expires_at\nOK-1,\nbad code,\nOK-2,someday\nab,\nOK-3,2026-12-01\n",
    );
    expect(r.valid.map((c) => c.code)).toEqual(["OK-1", "OK-3"]);
    expect(r.invalid).toEqual([
      { line: 3, value: "bad code", reason: "format" },
      { line: 4, value: "someday", reason: "date" },
      { line: 5, value: "ab", reason: "format" },
    ]);
  });

  it("copes with a BOM, quotes and CRLF from Excel", () => {
    const r = parseCodesCsv('﻿"code"\r\n"AAA-111"\r\n"BBB-222"\r\n');
    expect(r.valid.map((c) => c.code)).toEqual(["AAA-111", "BBB-222"]);
  });
});

describe("alert settings", () => {
  it("parses thresholds as percentages, highest first", () => {
    expect(parseThresholds("5, 20%")).toEqual([20, 5]);
    expect(parseThresholds("20 20 10")).toEqual([20, 10]);
    expect(parseThresholds("")).toBeNull();
    expect(parseThresholds("0")).toBeNull();
    expect(parseThresholds("100")).toBeNull();
    expect(parseThresholds("a")).toBeNull();
    expect(parseThresholds("1 2 3 4 5 6")).toBeNull();
  });

  it("parses recipient lists", () => {
    expect(parseEmailList("A@x.com; b@x.com  a@x.com")).toEqual(["a@x.com", "b@x.com"]);
    expect(parseEmailList("")).toEqual([]);
    expect(parseEmailList("nope")).toBeNull();
  });

  it("picks the lowest threshold a pool is at or under", () => {
    expect(levelFor(50, [20, 5])).toBeNull();
    expect(levelFor(20, [20, 5])).toBe(20);
    expect(levelFor(12, [20, 5])).toBe(20);
    expect(levelFor(5, [20, 5])).toBe(5);
    expect(levelFor(0, [20, 5])).toBe(5);
  });

  it("counts the pool without voided codes", () => {
    expect(percentLeft({ total: 100, void: 0, available: 25 })).toBe(25);
    expect(percentLeft({ total: 100, void: 50, available: 25 })).toBe(50);
    expect(percentLeft({ total: 0, void: 0, available: 0 })).toBe(100);
  });
});
