// The fact-extractor port: read digitised pages against a field list and
// report raw fields with value, per-field confidence, and a verbatim
// snippet. Implementations: LlmExtractor (live), FixtureExtractor (cached).
//
// The extractor is untrusted by construction: the pipeline verifies every
// snippet against the digitised text and stitches bounding boxes itself,
// so nothing an implementation returns can become a trusted fact without
// verified provenance.

import { FieldSpec } from "../core/fields";
import { DigitisedPage, RawExtractedField } from "../core/pipeline";

export interface FactExtractor {
  /** Model identifier recorded in manifests. */
  readonly modelId: string;
  extract(pages: DigitisedPage[], specs: FieldSpec[]): Promise<RawExtractedField[]>;
}

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}
