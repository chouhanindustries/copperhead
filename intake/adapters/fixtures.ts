// Fixture-backed implementations of both ports: cached JSON, zero network.
// USE_FIXTURES=true composes these instead of the live providers; the same
// files double as the content-addressed cache written by live runs.

import { FieldSpec } from "../core/fields";
import { DigitisedPage, RawExtractedField } from "../core/pipeline";
import { DigitisationProvider, DigitiseFailedError, DocumentInput } from "../ports/digitisation";
import { ExtractionError, FactExtractor } from "../ports/extractor";
import { digitiseCacheKey, extractCacheKey, JsonCache } from "./cache";

export class FixtureDigitisationProvider implements DigitisationProvider {
  readonly modelId = "sarvam-vision (fixtures)";
  constructor(private readonly cache: JsonCache) {}

  async digitise(doc: DocumentInput): Promise<DigitisedPage[]> {
    const pages = this.cache.read<DigitisedPage[]>(digitiseCacheKey(doc.bytes));
    if (!pages) {
      throw new DigitiseFailedError(
        `no digitise fixture for ${doc.fileName}; generate fixtures with a live run first`,
      );
    }
    return pages;
  }
}

export class FixtureExtractor implements FactExtractor {
  readonly modelId: string;
  private readonly docBytes: Buffer;

  constructor(
    private readonly cache: JsonCache,
    docBytes: Buffer,
    modelId = "claude-opus-5 (fixtures)",
  ) {
    this.docBytes = docBytes;
    this.modelId = modelId;
  }

  async extract(_pages: DigitisedPage[], specs: FieldSpec[]): Promise<RawExtractedField[]> {
    const fields = this.cache.read<RawExtractedField[]>(extractCacheKey(this.docBytes, specs));
    if (!fields) {
      throw new ExtractionError(
        "no extractor fixture for this document and field list; generate fixtures with a live run first",
      );
    }
    return fields;
  }
}
