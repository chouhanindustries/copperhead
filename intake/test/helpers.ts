import { BoundingBox, Constraint, ExtractedFact, TrustedFact, HeldFact } from "../core/model";
import { assembleFacts, DigitisedPage, RawExtractedField } from "../core/pipeline";
import { FieldSpec } from "../core/fields";

/** assembleFacts for exactly one raw field, asserting one fact comes back. */
export function firstFact(
  rawFields: RawExtractedField[],
  pages: DigitisedPage[],
  specs?: FieldSpec[],
): ExtractedFact {
  const facts = specs ? assembleFacts(rawFields, pages, specs) : assembleFacts(rawFields, pages);
  const fact = facts[0];
  if (!fact) throw new Error("expected at least one fact");
  return fact;
}

export function bbox(page: number, overrides: Partial<BoundingBox> = {}): BoundingBox {
  return { page, x: 0.1, y: 0.2, width: 0.3, height: 0.05, ...overrides };
}

export function trustedFact(overrides: Partial<TrustedFact> = {}): TrustedFact {
  return {
    key: "pin_input_leakage_uA",
    rawField: "Input leakage current",
    value: 33,
    unit: "uA",
    confidence: 0.95,
    status: "trusted",
    source: { page: 2, bbox: bbox(2), snippet: "Input leakage current 0.033 mA" },
    ...overrides,
  };
}

export function heldFact(overrides: Partial<HeldFact> = {}): HeldFact {
  return {
    key: "pin_input_leakage_uA",
    rawField: "Input leakage current",
    value: 33,
    unit: "uA",
    confidence: 0.6,
    status: "hold",
    source: { page: 2 },
    holdReason: "confidence 0.60 below threshold 0.75",
    ...overrides,
  };
}

export function sleepBudget(overrides: Partial<Constraint> = {}): Constraint {
  return {
    id: "sleep_current_budget",
    description: "board sleeps within 25 uA",
    kind: "budget_sum",
    limit: 25,
    unit: "uA",
    affects: ["pin_input_leakage_uA"],
    source: "board SPEC sleep budget",
    ...overrides,
  };
}

export function railMax(overrides: Partial<Constraint> = {}): Constraint {
  return {
    id: "rail_voltage_max",
    description: "no pin driven above the rail abs-max",
    kind: "max",
    limit: 5,
    unit: "V",
    affects: ["abs_max_vin_V"],
    source: "board SPEC rail",
    ...overrides,
  };
}

export function digitisedPage(overrides: Partial<DigitisedPage> = {}): DigitisedPage {
  return {
    page: 2,
    text: "Electrical characteristics. Input leakage current 0.033 mA at 25 C. Absolute maximum input voltage 3.6 V.",
    regions: [
      { text: "Input leakage current 0.033 mA at 25 C", bbox: bbox(2) },
      { text: "Absolute maximum input voltage 3.6 V", bbox: bbox(2, { y: 0.4 }) },
    ],
    ...overrides,
  };
}

export function rawField(overrides: Partial<RawExtractedField> = {}): RawExtractedField {
  return {
    field: "Input leakage current",
    value: 0.033,
    unit: "mA",
    page: 2,
    snippet: "Input leakage current 0.033 mA",
    confidence: 0.95,
    ...overrides,
  };
}
