/**
 * Refreshes the disposable-email blocklist (DATA-04) from the community-maintained list
 * (CC0): https://github.com/disposable-email-domains/disposable-email-domains
 * Usage: npm run update:disposable, then commit lib/server/data/disposable-domains.json.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

const SOURCE =
  "https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf";
const OUT = path.resolve("lib/server/data/disposable-domains.json");

async function main() {
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const domains = [
    ...new Set(
      (await res.text())
        .split("\n")
        .map((line) => line.trim().toLowerCase())
        .filter((line) => line !== "" && !line.startsWith("#")),
    ),
  ].sort();
  if (domains.length < 1000) throw new Error(`Only ${domains.length} domains; refusing to write`);
  writeFileSync(OUT, `${JSON.stringify({ source: SOURCE, domains })}\n`);
  console.log(`Wrote ${domains.length} domains to ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
