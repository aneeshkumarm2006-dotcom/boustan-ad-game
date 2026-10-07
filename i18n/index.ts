/**
 * Runtime i18n for the page and the canvas (PRD L10N-01 to L10N-06). Both dictionaries are
 * small and ship together, so switching language never waits on the network (L10N-03).
 */
import en from "./en.json";
import fr from "./fr.json";

export const LANGS = ["fr", "en"] as const;
export type Lang = (typeof LANGS)[number];
export const DEFAULT_LANG: Lang = "fr";

export type Dict = typeof en;
const DICTS: Record<Lang, Dict> = { en, fr };

/** Dot paths to every string leaf, e.g. "save.cta" or "results.death.pita". */
type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string
    ? `${P}${K}`
    : T[K] extends readonly unknown[]
      ? never
      : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];
/** Dot paths to string arrays, e.g. "canvas.hits". */
type Lists<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends readonly string[]
    ? `${P}${K}`
    : T[K] extends string
      ? never
      : Lists<T[K], `${P}${K}.`>;
}[keyof T & string];
/** Paths that have `one` and `other` plural forms, e.g. "share.text". */
type Plurals<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends { one: string; other: string }
    ? `${P}${K}`
    : T[K] extends string | readonly unknown[]
      ? never
      : Plurals<T[K], `${P}${K}.`>;
}[keyof T & string];

export type TKey = Leaves<Dict>;
export type TListKey = Lists<Dict>;
export type TPluralKey = Plurals<Dict>;
export type Vars = Record<string, string | number>;

export function isLang(value: unknown): value is Lang {
  return value === "fr" || value === "en";
}

/** BCP 47 locale for Intl: Canadian French and Canadian English. */
export function localeOf(lang: Lang): string {
  return lang === "fr" ? "fr-CA" : "en-CA";
}

function lookup(dict: Dict, key: string): unknown {
  let node: unknown = dict;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

export function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

export interface Translator {
  lang: Lang;
  locale: string;
  t(key: TKey, vars?: Vars): string;
  list(key: TListKey, vars?: Vars): string[];
  plural(key: TPluralKey, count: number, vars?: Vars): string;
  /** Whole number with the locale's grouping (FR "1 234", EN "1,234"). */
  num(n: number): string;
  /** Short date (FR "15 oct. 2026", EN "Oct 15, 2026"), with no-break spaces: it never splits. */
  date(value: Date | string | number): string;
}

const translators = new Map<Lang, Translator>();

/** One translator per language, cached. Intl formatters are built on first use: they're slow to
 * create and the start screen doesn't need them. */
export function createTranslator(lang: Lang): Translator {
  const cached = translators.get(lang);
  if (cached) return cached;
  const dict = DICTS[lang];
  const locale = localeOf(lang);
  let numbers: Intl.NumberFormat | undefined;
  let dates: Intl.DateTimeFormat | undefined;
  let plurals: Intl.PluralRules | undefined;
  const t = (key: TKey, vars?: Vars): string => {
    const value = lookup(dict, key);
    return typeof value === "string" ? interpolate(value, vars) : key;
  };
  const translator: Translator = {
    lang,
    locale,
    t,
    list(key, vars) {
      const value = lookup(dict, key);
      return Array.isArray(value) ? value.map((item) => interpolate(String(item), vars)) : [];
    },
    plural(key, count, vars) {
      plurals ??= new Intl.PluralRules(locale);
      const forms = lookup(dict, key) as Record<string, string> | undefined;
      const form = forms?.[plurals.select(count)] ?? forms?.other ?? key;
      return interpolate(form, { count, ...vars });
    },
    num(n) {
      numbers ??= new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
      return numbers.format(Math.floor(n));
    },
    date(value) {
      dates ??= new Intl.DateTimeFormat(locale, {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
      return dates.format(new Date(value)).replace(/ /g, " ");
    },
  };
  translators.set(lang, translator);
  return translator;
}

/**
 * Language order (L10N-02): the `?lang` parameter, then the player's saved choice, then the
 * browser language (`fr*` gives French, anything else English), then French.
 */
export function pickLanguage(options: {
  param?: string | null;
  saved?: string | null;
  browser?: readonly string[];
}): Lang {
  const param = options.param?.trim().toLowerCase();
  if (isLang(param)) return param;
  if (isLang(options.saved)) return options.saved;
  const first = options.browser?.find((tag) => tag.trim() !== "");
  if (first) return first.toLowerCase().startsWith("fr") ? "fr" : "en";
  return DEFAULT_LANG;
}

export type RichPart = { text: string; tag?: string };

/**
 * Splits "Accept the <terms>offer terms</terms>." into plain and tagged parts, so a
 * translation can place links anywhere in its sentence. Tags don't nest.
 */
export function splitRich(text: string): RichPart[] {
  const parts: RichPart[] = [];
  const pattern = /<([a-z]+)>(.*?)<\/\1>/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    parts.push({ text: match[2], tag: match[1] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
