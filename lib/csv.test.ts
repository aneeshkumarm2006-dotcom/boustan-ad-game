import { describe, expect, it } from "vitest";
import { csvCell, parseCsv, toCsv } from "./csv";

describe("parseCsv", () => {
  it("reads plain rows, CRLF and LF, and skips blank lines", () => {
    expect(parseCsv("email\r\na@x.ca\nb@x.ca\n\n")).toEqual([["email"], ["a@x.ca"], ["b@x.ca"]]);
  });
  it("reads quotes, commas and newlines inside quotes", () => {
    expect(parseCsv('a,"b,c","d ""q"" e","x\ny"\n')).toEqual([["a", "b,c", 'd "q" e', "x\ny"]]);
  });
  it("drops a byte-order mark and keeps a last row without a newline", () => {
    expect(parseCsv("﻿email,points\na@x.ca,120")).toEqual([
      ["email", "points"],
      ["a@x.ca", "120"],
    ]);
  });
  it("keeps empty fields, drops rows that are all empty", () => {
    expect(parseCsv("A,,C\n,,\n")).toEqual([["A", "", "C"]]);
  });
  it("handles an empty file", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("\n\n")).toEqual([]);
  });
});

describe("csv output", () => {
  it("quotes only when needed", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell(null)).toBe("");
    expect(csvCell(12)).toBe("12");
  });
  it("defuses spreadsheet formulas but leaves numbers alone", () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("+1 514")).toBe("'+1 514");
    expect(csvCell("@evil")).toBe("'@evil");
    expect(csvCell("-5")).toBe("-5");
  });
  it("defuses a nickname that starts like a formula, since players choose them", () => {
    expect(csvCell("-1+1")).toBe("'-1+1");
    expect(csvCell("=1+1")).toBe("'=1+1");
  });
  it("writes a BOM, CRLF and a round trip", () => {
    const out = toCsv(["a", "b"], [["é", "x,y"]]);
    expect(out.startsWith("﻿")).toBe(true);
    expect(out).toContain("\r\n");
    expect(parseCsv(out)).toEqual([
      ["a", "b"],
      ["é", "x,y"],
    ]);
  });
});
