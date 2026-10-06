/**
 * CI gate for PRD L10N-01 / AC-09: fails when fr.json and en.json differ.
 * Usage: tsx scripts/check-i18n.ts [directory]   (default: ./i18n)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { checkParity } from "../i18n/parity";

const LOCALES = ["en", "fr"] as const;
const dir = path.resolve(process.argv[2] ?? "i18n");

const locales: Record<string, unknown> = {};
for (const locale of LOCALES) {
  const file = path.join(dir, `${locale}.json`);
  try {
    locales[locale] = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`i18n: cannot read ${file}: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

const problems = checkParity(locales);
if (problems.length > 0) {
  console.error(`i18n: ${problems.length} problem(s) in ${dir}`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`i18n OK: ${LOCALES.join(" + ")} are in sync`);
