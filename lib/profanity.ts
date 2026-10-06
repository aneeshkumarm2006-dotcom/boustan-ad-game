/**
 * English + French profanity check for leaderboard nicknames (LB-05). Shared by the claim form
 * (instant feedback) and the server (which decides). Names are folded first (case, accents,
 * look-alike digits and symbols, separators, repeated letters), so "T4b@rnak" and "f.u.c.k"
 * don't slip through.
 *
 * Two lists, to avoid the Scunthorpe problem: STEMS are matched inside longer words and across
 * separators; WORDS only count as a whole word ("nique" is in "unique", "pute" in "computer").
 * The lists are a starting point, and admins can hide or rename anything that gets through
 * (LB-07).
 */

const STEMS = [
  // English
  "fuck",
  "shit",
  "bitch",
  "nigg",
  "fagg",
  "retard",
  "whore",
  "slut",
  "pussy",
  "bastard",
  "wank",
  "twat",
  "rapist",
  "nazi",
  "hitler",
  "porn",
  "jizz",
  "blowjob",
  "handjob",
  "dildo",
  // French and Québécois (sacres)
  "merde",
  "putain",
  "salope",
  "encule",
  "connard",
  "connasse",
  "bordel",
  "batard",
  "niquer",
  "foutre",
  "tabarn",
  "tabarouette",
  "calisse",
  "calice",
  "caliss",
  "ostie",
  "crisse",
  "criss",
  "ciboire",
  "sacrament",
  "baise",
  "couille",
  "troudecul",
  "negre",
] as const;

const WORDS = new Set([
  "ass",
  "arse",
  "tit",
  "tits",
  "cum",
  "sex",
  "anal",
  "fag",
  "homo",
  "paki",
  "coon",
  "spic",
  "kike",
  "chink",
  "gook",
  "damn",
  "crap",
  "piss",
  "cul",
  "con",
  "cons",
  "zob",
  "fdp",
  "ntm",
  "pd",
  "cunt",
  "cunts",
  "dick",
  "dicks",
  "dickhead",
  "cock",
  "cocks",
  "cocksucker",
  "kkk",
  "bite",
  "bites",
  "pute",
  "putes",
  "nique",
  "osti",
  "esti",
  "penis",
  "vagin",
  "vagina",
]);

const LOOKALIKES: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "9": "g",
  "@": "a",
  $: "s",
  "!": "i",
  "+": "t",
  "€": "e",
  "|": "i",
};

/** Lowercase, no accents, look-alikes mapped to letters, runs of 3+ letters cut to 2. */
function fold(input: string): string {
  const base = input
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae");
  return Array.from(base, (c) => LOOKALIKES[c] ?? c)
    .join("")
    .replace(/(.)\1{2,}/g, "$1$1");
}

const squash = (s: string) => s.replace(/(.)\1+/g, "$1");

export function isProfane(input: string): boolean {
  // A number on its own ("Flash 17") is never part of a word, and as a look-alike ("17" = "it")
  // it would join the words around it ("flashit").
  const folded = fold(input.replace(/(^|[^\p{L}\p{N}])\d+(?=$|[^\p{L}\p{N}])/gu, "$1"));
  for (const word of folded.split(/[^a-z]+/)) if (word && WORDS.has(word)) return true;

  // Each word with its punctuation removed ("f.u.c.k"), plus letters spread out one or two at
  // a time ("f u c k"). Separate whole words are never joined: "Flash It" is not "shit".
  const words = folded
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z]/g, ""))
    .filter(Boolean);
  const candidates = [...words];
  let run = "";
  for (const w of [...words, ""]) {
    if (w.length > 0 && w.length <= 2) run += w;
    else {
      if (run.length >= 3) candidates.push(run);
      run = "";
    }
  }
  return candidates.some((c) =>
    STEMS.some((stem) => c.includes(stem) || squash(c).includes(squash(stem))),
  );
}
