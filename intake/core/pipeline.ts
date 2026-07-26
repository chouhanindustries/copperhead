// Fact pipeline: turn raw extractor output plus digitised pages into
// ExtractedFact[], enforcing snippet verification, deterministic bbox
// stitching, and the confidence gate. Pure module: no I/O.

import {
  BoundingBox,
  CONFIDENCE_THRESHOLD,
  ExtractedFact,
  HeldFact,
  SourceRef,
  TrustedFact,
} from "./model";
import { FieldSpec, DEFAULT_FIELD_SPECS, resolveFieldSpec } from "./fields";
import { convert, isConvertible } from "./units";

/** One field as reported by a FactExtractor implementation. */
export interface RawExtractedField {
  /** The field label the extractor used, e.g. "Input leakage current". */
  field: string;
  value: number | string;
  /** Unit as printed in the datasheet, e.g. "mA". */
  unit?: string;
  /** 1-based page number the value was read from. */
  page: number;
  /** Verbatim snippet from the digitised text containing the value. */
  snippet: string;
  /** True when the value is qualified by a footnote marker. */
  footnoteQualified?: boolean;
  /** Extractor-reported confidence in [0, 1]. */
  confidence: number;
}

/** One region of a digitised page, with its bounding box. */
export interface DigitisedRegion {
  text: string;
  bbox: BoundingBox;
}

export interface DigitisedPage {
  /** 1-based page number. */
  page: number;
  /** Full concatenated text of the page. */
  text: string;
  regions: DigitisedRegion[];
}

/** Collapse whitespace so snippet matching survives layout differences. */
function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function snippetOccursIn(snippet: string, text: string): boolean {
  const needle = squash(snippet);
  return needle.length > 0 && squash(text).includes(needle);
}

/** Deterministically locate the region containing the snippet, if any. */
function locateRegion(
  snippet: string,
  page: DigitisedPage,
): DigitisedRegion | undefined {
  return page.regions.find((r) => snippetOccursIn(snippet, r.text));
}

interface NormalizedValue {
  value: number | string;
  unit?: string;
  /** Set when the unit could not be normalized; forces a hold. */
  problem?: string;
}

function normalizeValue(raw: RawExtractedField, spec?: FieldSpec): NormalizedValue {
  if (typeof raw.value !== "number") {
    const out: NormalizedValue = { value: raw.value };
    if (raw.unit !== undefined) out.unit = raw.unit;
    return out;
  }
  if (!spec?.targetUnit) {
    const out: NormalizedValue = { value: raw.value };
    if (raw.unit !== undefined) out.unit = raw.unit;
    return out;
  }
  const unit = raw.unit ?? spec.targetUnit;
  if (!isConvertible(unit, spec.targetUnit)) {
    return {
      value: raw.value,
      unit,
      problem: `unit "${unit}" not convertible to ${spec.targetUnit}`,
    };
  }
  return { value: convert(raw.value, unit, spec.targetUnit), unit: spec.targetUnit };
}

function held(
  raw: RawExtractedField,
  key: string,
  normalized: NormalizedValue,
  source: SourceRef,
  holdReason: string,
): HeldFact {
  const fact: HeldFact = {
    key,
    rawField: raw.field,
    value: normalized.value,
    confidence: raw.confidence,
    status: "hold",
    source,
    holdReason,
  };
  if (normalized.unit !== undefined) fact.unit = normalized.unit;
  return fact;
}

/**
 * Assemble facts from extractor output and digitised pages.
 *
 * Trust requires all of: snippet verified against the digitised page text,
 * a located bounding box, confidence at or above the threshold, no footnote
 * qualifier, and a cleanly normalized unit. Anything less is a held fact:
 * there is no code path to a trusted fact without verified provenance.
 */
export function assembleFacts(
  rawFields: RawExtractedField[],
  pages: DigitisedPage[],
  specs: FieldSpec[] = DEFAULT_FIELD_SPECS,
): ExtractedFact[] {
  return rawFields.map((raw) => {
    const spec = resolveFieldSpec(raw.field, specs);
    const key = spec?.key ?? raw.field;
    const normalized = normalizeValue(raw, spec);

    const page = pages.find((p) => p.page === raw.page);
    const baseSource: SourceRef = { page: raw.page, snippet: raw.snippet };

    if (!page) {
      return held(raw, key, normalized, baseSource, `page ${raw.page} not in digitised output`);
    }
    if (!snippetOccursIn(raw.snippet, page.text)) {
      return held(
        raw,
        key,
        normalized,
        baseSource,
        "snippet not found in digitised text; value cannot be verified",
      );
    }

    const region = locateRegion(raw.snippet, page);
    if (!region) {
      return held(raw, key, normalized, baseSource, "no digitised region matches the snippet");
    }
    if (raw.confidence < CONFIDENCE_THRESHOLD) {
      return held(
        raw,
        key,
        normalized,
        { ...baseSource, bbox: region.bbox },
        `confidence ${raw.confidence.toFixed(2)} below threshold ${CONFIDENCE_THRESHOLD}`,
      );
    }
    if (raw.footnoteQualified) {
      return held(
        raw,
        key,
        normalized,
        { ...baseSource, bbox: region.bbox },
        "value is qualified by a datasheet footnote",
      );
    }
    if (normalized.problem) {
      return held(
        raw,
        key,
        normalized,
        { ...baseSource, bbox: region.bbox },
        normalized.problem,
      );
    }

    const fact: TrustedFact = {
      key,
      rawField: raw.field,
      value: normalized.value,
      confidence: raw.confidence,
      status: "trusted",
      source: { page: raw.page, bbox: region.bbox, snippet: raw.snippet },
    };
    if (normalized.unit !== undefined) fact.unit = normalized.unit;
    return fact;
  });
}
