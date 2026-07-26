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
  return {
    cache,
    digitiser: new SarvamProvider({ workDir: join(fixturesDir, "cache") }),
    extractor: new LlmExtractor(),
  };
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
