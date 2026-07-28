// Live fixture generation: run the real Sarvam Digitise + LLM extraction
// pipeline on a datasheet PDF and leave the results in fixtures/cache/,
// where the fixture providers (USE_FIXTURES=true) and the demo serve them
// offline. Usage:
//
//   npx tsx scripts/generate-fixtures.ts fixtures/datasheets/<name>.pdf
//
// Reads SARVAM_API_KEY from intake/.env or the repo root .env; the
// Anthropic client resolves its own credentials (env var or ant profile).

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildIngestDeps, ingest } from "../adapters/ingest";
import { isTrusted } from "../core/model";

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && match[1] && process.env[match[1]] === undefined && match[2] !== "") {
      process.env[match[1]] = match[2];
    }
  }
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: npx tsx scripts/generate-fixtures.ts <datasheet.pdf>");
    process.exit(1);
  }
  loadEnvFile(join(process.cwd(), ".env"));
  loadEnvFile(join(process.cwd(), "..", ".env"));

  const path = resolve(target);
  const doc = { fileName: path.split("/").pop()!, bytes: readFileSync(path) };
  const fixturesDir = join(process.cwd(), "fixtures");

  console.log(`Ingesting ${doc.fileName} (${doc.bytes.length} bytes)…`);
  const started = Date.now();
  const result = await ingest(doc, buildIngestDeps(doc, fixturesDir));
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\nDone in ${seconds}s via ${result.digitiseModel} + ${result.extractorModel}`);
  console.log(`Pages: ${result.pages.length}; regions: ${result.pages.map((p) => p.regions.length).join(", ")}`);
  console.log(`\nFacts:`);
  for (const fact of result.facts) {
    const status = isTrusted(fact) ? "trusted" : `HOLD (${fact.holdReason})`;
    console.log(
      `  ${fact.key} = ${fact.value} ${fact.unit ?? ""}  conf=${fact.confidence.toFixed(2)}  p.${fact.source.page}  ${status}`,
    );
  }
  const trusted = result.facts.filter(isTrusted).length;
  console.log(
    `\nTrusted-fact rate: ${trusted}/${result.facts.length}${result.facts.length ? ` (${((100 * trusted) / result.facts.length).toFixed(0)}%)` : ""}`,
  );
  console.log(`Cache written under fixtures/cache/ — commit to serve as demo fixtures.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
