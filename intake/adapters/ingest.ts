// Ingestion composition: cache -> digitise -> extract -> assemble facts.
// Providers are selected at composition time (the cached/live mode is a
// provider swap, not an if-branch inside logic), constructed lazily so a
// warm cache needs zero keys, and narrate progress via onProgress.

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

export type IngestMode = "cached" | "live";

export interface IngestDeps {
  digitiser: DigitisationProvider;
  extractor: FactExtractor;
  cache: JsonCache;
}

export interface IngestOptions {
  /** Skip cache reads (still writes), so live calls actually happen. */
  refresh?: boolean;
  onProgress?: (message: string) => void;
}

export interface IngestResult {
  pages: DigitisedPage[];
  rawFields: RawExtractedField[];
  facts: ExtractedFact[];
  digitiseModel: string;
  extractorModel: string;
}

export interface BuildDepsOptions {
  /** "cached" forces fixtures (zero network); "live" forces real providers; default: env. */
  mode?: IngestMode;
  onProgress?: (message: string) => void;
}

export function buildIngestDeps(
  doc: DocumentInput,
  fixturesDir: string,
  opts: BuildDepsOptions = {},
): IngestDeps {
  const cache = new JsonCache(join(fixturesDir, "cache"));
  const onProgress = opts.onProgress ?? (() => {});
  const cached = opts.mode ? opts.mode === "cached" : process.env.USE_FIXTURES === "true";

  if (cached) {
    return {
      cache,
      digitiser: new FixtureDigitisationProvider(cache),
      extractor: new FixtureExtractor(cache, doc.bytes),
    };
  }
  // Live providers are constructed lazily, on first actual use: with a warm
  // cache the whole flow runs with no keys configured at all.
  return {
    cache,
    digitiser: {
      modelId: "sarvam-vision",
      digitise: (d) =>
        new SarvamProvider({ workDir: join(fixturesDir, "cache"), onProgress }).digitise(d),
    },
    extractor: {
      modelId: extractorName(),
      extract: (pages, specs) => pickExtractor(onProgress).extract(pages, specs),
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
 * Claude Code saved login (Agent SDK subprocess, no API key) is the fallback.
 */
function pickExtractor(onProgress: (message: string) => void) {
  const forced = process.env.INTAKE_EXTRACTOR;
  if (forced === "api") return new LlmExtractor({ onProgress });
  if (forced === "claude-code") return new ClaudeCodeExtractor({ onProgress });
  return process.env.ANTHROPIC_API_KEY
    ? new LlmExtractor({ onProgress })
    : new ClaudeCodeExtractor({ onProgress });
}

/**
 * Ingest a datasheet. The content-addressed cache is consulted before any
 * provider call (unless refresh): a document is digitised once, ever, and
 * the LLM extractor runs at most once per (document, field list).
 */
export async function ingest(
  doc: DocumentInput,
  deps: IngestDeps,
  specs: FieldSpec[] = DEFAULT_FIELD_SPECS,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const onProgress = opts.onProgress ?? (() => {});

  const digitiseKey = digitiseCacheKey(doc.bytes);
  let pages = opts.refresh ? undefined : deps.cache.read<DigitisedPage[]>(digitiseKey);
  if (pages) {
    onProgress(`digitised pages served from cache (${pages.length} pages, content-addressed)`);
  } else {
    onProgress(`digitising ${doc.fileName} with ${deps.digitiser.modelId}`);
    pages = await deps.digitiser.digitise(doc);
    deps.cache.write(digitiseKey, pages);
    onProgress(`digitised ${pages.length} pages, ${pages.reduce((n, p) => n + p.regions.length, 0)} regions with bounding boxes`);
  }

  const extractKey = extractCacheKey(doc.bytes, specs);
  let rawFields = opts.refresh ? undefined : deps.cache.read<RawExtractedField[]>(extractKey);
  if (rawFields) {
    onProgress(`extracted fields served from cache (${rawFields.length} fields)`);
  } else {
    onProgress(`extracting ${specs.length} fields with ${deps.extractor.modelId}`);
    rawFields = await deps.extractor.extract(pages, specs);
    deps.cache.write(extractKey, rawFields);
    onProgress(`extractor returned ${rawFields.length} fields`);
  }

  onProgress("verifying snippets against digitised text, stitching bounding boxes, applying the 0.75 confidence gate");
  const facts = assembleFacts(rawFields, pages, specs);
  const trusted = facts.filter((f) => f.status === "trusted").length;
  onProgress(`${trusted} of ${facts.length} facts trusted; the rest are held for review`);

  return {
    pages,
    rawFields,
    facts,
    digitiseModel: deps.digitiser.modelId,
    extractorModel: deps.extractor.modelId,
  };
}
