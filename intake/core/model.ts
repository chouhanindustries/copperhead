// Core data model for the datasheet intake surface.
// This module is pure: no I/O, no SDK imports, no framework imports.

// --- Provenance (from Sarvam Digitise bounding boxes) ---

/** Normalized 0..1 page-relative coordinates. */
export interface BoundingBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SourceRef {
  page: number;
  bbox?: BoundingBox;
  snippet?: string;
}

/** A SourceRef that is guaranteed to carry a bounding box. */
export interface VerifiedSourceRef extends SourceRef {
  bbox: BoundingBox;
  snippet: string;
}

// --- Facts ---

export type FactStatus = "trusted" | "hold";

interface FactBase {
  /** Canonical predicate key, e.g. "pin_input_leakage_uA". */
  key: string;
  /** The field label the extractor used, e.g. "Input leakage current". */
  rawField: string;
  value: number | string;
  /** Normalized unit, e.g. "uA", "V". */
  unit?: string;
  /** 0..1, per-field confidence reported by the extractor. */
  confidence: number;
}

/**
 * A trusted fact structurally requires a verified source (page + bbox +
 * snippet). There is no way to construct a trusted fact without provenance.
 */
export interface TrustedFact extends FactBase {
  status: "trusted";
  source: VerifiedSourceRef;
}

export interface HeldFact extends FactBase {
  status: "hold";
  source: SourceRef;
  /** Why this fact is held, e.g. "confidence 0.61 below threshold 0.75". */
  holdReason: string;
}

export type ExtractedFact = TrustedFact | HeldFact;

export function isTrusted(fact: ExtractedFact): fact is TrustedFact {
  return fact.status === "trusted";
}

// --- Constraints (the board's rulebook) ---

export type ConstraintKind = "budget_sum" | "max" | "min" | "equality";

export interface Constraint {
  id: string;
  /** Human contract line, quoted verbatim in refusals. */
  description: string;
  kind: ConstraintKind;
  limit: number;
  unit: string;
  /** Fact keys this constraint consumes. */
  affects: string[];
  /** Where the rule came from, e.g. "board SPEC sleep budget". */
  source: string;
}

export interface Registry {
  part: string;
  facts: ExtractedFact[];
  constraints: Constraint[];
}

// --- Proposed changes ---

export type ChangeKind = "add_component" | "connect_rail" | "swap_part";

/** One quantified consequence of a change, e.g. "+33 uA against pin_input_leakage_uA". */
export interface Contribution {
  /** The fact key this contribution is measured by (or checked against). */
  factKey: string;
  /**
   * The numeric contribution of the change itself, when the change adds a
   * quantity (e.g. pull-up current into a budget). Omitted when the check is
   * the fact value against the constraint limit directly (e.g. abs-max).
   */
  value?: number;
  unit?: string;
}

export interface ChangeDescriptor {
  kind: ChangeKind;
  /** Human-readable label, e.g. "add 100k pull-up on GPIO12". */
  label: string;
  contributions: Contribution[];
}

// --- Verdicts ---

export type Decision = "APPROVE" | "REFUSE" | "HOLD";

export interface Computed {
  expression: string;
  result: number;
  limit: number;
  unit: string;
}

export interface Verdict {
  change: string;
  decision: Decision;
  /** One engineer-grade sentence. */
  reason: string;
  citedFact?: ExtractedFact;
  citedConstraint?: Constraint;
  computed?: Computed;
  proposedFix?: string;
}

// --- Exportable audit artifact ---

export interface VerificationManifest {
  /** Injected by the caller; core never reads the clock. */
  timestampISO: string;
  part: string;
  change: string;
  checksRun: string[];
  factsUsed: ExtractedFact[];
  verdict: Verdict;
  extraction: {
    digitiseModel: string;
    extractorModel: string;
  };
  /** The exact inputs needed to reproduce the verdict. */
  inputs: {
    descriptor: ChangeDescriptor;
    constraints: Constraint[];
  };
}

// --- Shared constants ---

export const CONFIDENCE_THRESHOLD = 0.75;
