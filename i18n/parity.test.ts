import { describe, expect, it } from "vitest";
import en from "./en.json";
import fr from "./fr.json";
import { checkParity } from "./parity";

describe("shipped locale files", () => {
  it("fr.json and en.json have identical keys", () => {
    expect(checkParity({ en, fr })).toEqual([]);
  });
});

describe("checkParity", () => {
  const base = { save: { cta: "Save", email: "Email" }, lb: { title: "Board" } };

  it("accepts identical structures", () => {
    expect(checkParity({ en: base, fr: structuredClone(base) })).toEqual([]);
  });

  it("reports a key missing from one locale", () => {
    const missing = { save: { cta: "Enregistrer" }, lb: { title: "Classement" } };
    expect(checkParity({ en: base, fr: missing })).toEqual(['fr: missing "save.email"']);
  });

  it("reports an extra key as missing from the other locale", () => {
    const extra = { ...base, lb: { title: "Board", subtitle: "Top 10" } };
    expect(checkParity({ en: extra, fr: base })).toEqual(['fr: missing "lb.subtitle"']);
  });

  it("reports empty and whitespace-only values", () => {
    const blank = { save: { cta: "", email: "  " }, lb: { title: "Classement" } };
    expect(checkParity({ en: base, fr: blank })).toEqual([
      'fr: empty value for "save.cta"',
      'fr: empty value for "save.email"',
    ]);
  });

  it("reports mismatched interpolation placeholders", () => {
    const en = { score: "You ran {distance} m" };
    const fr = { score: "Vous avez couru {metres} m" };
    expect(checkParity({ en, fr })).toEqual([
      'fr: "score" uses placeholders {metres} but en uses {distance}',
    ]);
  });

  it("treats array entries as keys, so a shorter array is reported", () => {
    const en = { death: ["one", "two"] };
    const fr = { death: ["un"] };
    expect(checkParity({ en, fr })).toEqual(['fr: missing "death.1"']);
  });

  it("rejects values that are not strings, arrays or objects", () => {
    const bad = { save: { cta: 42 }, lb: { title: null } };
    expect(checkParity({ en: base, fr: bad })).toEqual(
      expect.arrayContaining([
        'fr: "save.cta" must be a string, array or object (got number)',
        'fr: "lb.title" must be a string, array or object (got null)',
      ]),
    );
  });

  it("rejects a top level that is not an object", () => {
    expect(checkParity({ en: base, fr: ["nope"] })).toContain("fr: top level must be an object");
  });
});
