import { describe, expect, it } from "vitest";
import { FOODS, MOODS, autoNickname, cleanNickname, nicknameProblem } from "./nicknames";
import { isProfane } from "./profanity";

describe("profanity filter (LB-05)", () => {
  it.each([
    "fuck",
    "F U C K",
    "f.u.c.k",
    "fuuuck you",
    "Sh1t",
    "b!tch",
    "T4b@rnak",
    "tabarnak",
    "Câlisse",
    "OSTIE",
    "esti",
    "Putain",
    "enculé",
    "Merde 42",
    "nique",
    "N1gg3r",
    "Hitler",
    "a$$",
  ])("rejects %s", (name) => {
    expect(isProfane(name)).toBe(true);
  });

  it.each([
    "Falafel Rapide 27",
    "Toum Turbo 81",
    "Marie-Ève",
    "Jean-François",
    "Classic Fan",
    "unique",
    "computer",
    "Scunthorpe",
    "Assassin",
    "Analyst",
    "Culture",
    "Cassie",
    "Hancock's Pita",
    "Poulet Rôti",
    "Pita Pilote",
    "Coq au vin",
    "Bitelli",
    "Flash It",
    "Pass Hit",
    "Flash 17",
  ])("accepts %s", (name) => {
    expect(isProfane(name)).toBe(false);
  });

  it("never flags a food name, whatever the combination", () => {
    for (const f of FOODS) {
      for (const m of MOODS) {
        for (let n = 1; n <= 99; n++)
          expect(isProfane(`${f} ${m} ${n}`), `${f} ${m} ${n}`).toBe(false);
      }
    }
  });
});

describe("nicknames", () => {
  it("accepts 2 to 16 characters with accents, digits, spaces and - _ . '", () => {
    expect(cleanNickname("  Éloïse   d'Or  ")).toBe("Éloïse d'Or");
    expect(cleanNickname("a")).toBeNull();
    expect(cleanNickname("x".repeat(17))).toBeNull();
    expect(cleanNickname("emoji 🎮")).toBeNull();
    expect(cleanNickname("<b>hi</b>")).toBeNull();
  });

  it("tells format problems from rude ones, and allows blank", () => {
    expect(nicknameProblem("")).toBeNull();
    expect(nicknameProblem("   ")).toBeNull();
    expect(nicknameProblem("ok name")).toBeNull();
    expect(nicknameProblem("a")).toBe("format");
    expect(nicknameProblem("tabarnak")).toBe("rude");
  });

  it("builds food names that fit the nickname rules, so a reroll is always valid", () => {
    for (let i = 0; i < 500; i++) expect(cleanNickname(autoNickname())).not.toBeNull();
  });
});
