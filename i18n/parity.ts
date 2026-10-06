/**
 * Checks that every locale file has the same keys (PRD L10N-01, AC-09).
 *
 * Nested objects and arrays are flattened to dot paths ("claim.cta", "death.0"), so a missing
 * array entry counts as a missing key. Returns one human-readable line per problem; an empty
 * list means the locales are in sync.
 */

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function joinPath(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function collect(
  node: unknown,
  path: string,
  leaves: Map<string, string>,
  problems: string[],
  locale: string,
): void {
  if (typeof node === "string") {
    leaves.set(path, node);
  } else if (Array.isArray(node)) {
    node.forEach((child, index) =>
      collect(child, joinPath(path, String(index)), leaves, problems, locale),
    );
  } else if (node !== null && typeof node === "object") {
    for (const [key, child] of Object.entries(node)) {
      collect(child, joinPath(path, key), leaves, problems, locale);
    }
  } else {
    const got = node === null ? "null" : typeof node;
    problems.push(`${locale}: "${path}" must be a string, array or object (got ${got})`);
  }
}

function placeholders(text: string): string {
  const names = new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1]));
  return names.size === 0 ? "none" : [...names].sort().join(", ");
}

export function checkParity(locales: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const flat = new Map<string, Map<string, string>>();

  for (const [locale, root] of Object.entries(locales)) {
    if (root === null || typeof root !== "object" || Array.isArray(root)) {
      problems.push(`${locale}: top level must be an object`);
      continue;
    }
    const leaves = new Map<string, string>();
    collect(root, "", leaves, problems, locale);
    flat.set(locale, leaves);
  }

  const allKeys = [...new Set([...flat.values()].flatMap((leaves) => [...leaves.keys()]))].sort();

  for (const [locale, leaves] of flat) {
    for (const key of allKeys) {
      const value = leaves.get(key);
      if (value === undefined) {
        problems.push(`${locale}: missing "${key}"`);
      } else if (value.trim() === "") {
        problems.push(`${locale}: empty value for "${key}"`);
      }
    }
  }

  // Interpolation names must match the first locale, or a translated string breaks at runtime.
  const [reference, ...others] = [...flat.keys()];
  const referenceLeaves = reference === undefined ? undefined : flat.get(reference);
  if (reference !== undefined && referenceLeaves !== undefined) {
    for (const locale of others) {
      const leaves = flat.get(locale);
      if (!leaves) continue;
      for (const key of allKeys) {
        const expected = referenceLeaves.get(key);
        const actual = leaves.get(key);
        if (expected === undefined || actual === undefined) continue;
        if (placeholders(expected) !== placeholders(actual)) {
          problems.push(
            `${locale}: "${key}" uses placeholders {${placeholders(actual)}} but ${reference} uses {${placeholders(expected)}}`,
          );
        }
      }
    }
  }

  return problems;
}
