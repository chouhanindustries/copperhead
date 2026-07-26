// Ingestion composition: cache -> digitise -> extract -> assemble facts.
// Providers are selected at composition time (USE_FIXTURES is a provider
// swap, not an if-branch inside logic).

import { join } from "node:path";
import { DEFAULT_FIELD_SPECS, FieldSpec } from "../core/fields";
import { ExtractedFact } from "../core/model";
import { assembleFacts, DigitisedPage, RawExtractedField } from "../core/pipeline";
import { DigitisationProvider, DocumentInput } from "../ports/digitisation";
import { FactExtractor } from "../ports/extractor";
import { digitiseCacheKey, extractCacheKey, JsonCache } from "./cache";
import { ClaudeCodeExtractor } from "./claude-code-extractor";
import { FixtureDigitisationProvider, FixtureExtractor } from "./fixtures";
import { LlmExtractor } from "./llm-extractor";
import { SarvamProvider } from "./sarvam";

export interface IngestDeps {
  digitiser: DigitisationProvider;
  extractor: FactExtractor;
  cache: JsonCache;
}

export interface IngestResult {
  pages: DigitisedPage[];
  rawFields: RawExtractedField[];
  facts: ExtractedFact[];
  digitiseModel: string;
  extractorModel: string;
}

/** Compose providers from the environment. */
export function buildIngestDeps(doc: DocumentInput, fixturesDir: string): IngestDeps {
  const cache = new JsonCache(join(fixturesDir, "cache"));
  if (process.env.USE_FIXTURES === "true") {
    return {
      cache,
      digitiser: new FixtureDigitisationProvider(cache),
      extractor: new FixtureExtractor(cache, doc.bytes),
    };
  }
  // Live providers are constructed lazily, on first actual use: with a warm
  // cache the whole flow runs with no keys configured at all, so a missing
  // credential can never break a fixture-served demo.
  return {
    cache,
    digitiser: {
      modelId: "sarvam-vision",
      digitise: (d) => new SarvamProvider({ workDir: join(fixturesDir, "cache") }).digitise(d),
    },
    extractor: {
      modelId: extractorName(),
      extract: (pages, specs) => pickExtractor().extract(pages, specs),
    },
  };
}

function extractorName(): string {
  const forced = process.env.INTAKE_EXTRACTOR;
  const model = process.env.INTAKE_EXTRACTOR_MODEL;
  if (forced === "api" || (forced !== "claude-code" && process.env.ANTHROPIC_API_KEY)) {
    return model ?? "claude-opus-5";
  }
  return `claude-code${model ? `:${model}` : ""}`;
}

/**
 * Extractor selection: INTAKE_EXTRACTOR forces "api" or "claude-code";
 * otherwise the API extractor runs when ANTHROPIC_API_KEY is set, and the
 * Claude Code saved login (Agent SDK subprocess, no API key) is the
 * fallback.
 */
function pickExtractor() {
  const forced = process.env.INTAKE_EXTRACTOR;
  if (forced === "api") return new LlmExtractor();
  if (forced === "claude-code") return new ClaudeCodeExtractor();
  return process.env.ANTHROPIC_API_KEY ? new LlmExtractor() : new ClaudeCodeExtractor();
}

/**
 * Ingest a datasheet. The content-addressed cache is consulted before any
 * provider call: a document is digitised once, ever, and the LLM extractor
 * runs at most once per (document, field list).
 */
export async function ingest(
  doc: DocumentInput,
  deps: IngestDeps,
  specs: FieldSpec[] = DEFAULT_FIELD_SPECS,
): Promise<IngestResult> {
  const digitiseKey = digitiseCacheKey(doc.bytes);
  let pages = deps.cache.read<DigitisedPage[]>(digitiseKey);
  if (!pages) {
    pages = await deps.digitiser.digitise(doc);
    deps.cache.write(digitiseKey, pages);
  }

  const extractKey = extractCacheKey(doc.bytes, specs);
  let rawFields = deps.cache.read<RawExtractedField[]>(extractKey);
  if (!rawFields) {
    rawFields = await deps.extractor.extract(pages, specs);
    deps.cache.write(extractKey, rawFields);
  }

  return {
    pages,
    rawFields,
    facts: assembleFacts(rawFields, pages, specs),
    digitiseModel: deps.digitiser.modelId,
    extractorModel: deps.extractor.modelId,
  };
}
