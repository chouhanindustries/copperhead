// Canonical field specifications: the fields we ask the extractor for and
// how their raw labels map to canonical predicate keys with target units.
// Pure module: no I/O.

export interface FieldSpec {
  /** Canonical predicate key, e.g. "pin_input_leakage_uA". */
  key: string;
  /** The plain-English field description given to the extractor. */
  prompt: string;
  /** Label fragments that identify this field in extractor output. */
  labels: string[];
  /** Canonical unit facts under this key are stored in, if numeric. */
  targetUnit?: string;
}

export const DEFAULT_FIELD_SPECS: FieldSpec[] = [
  {
    key: "supply_voltage_range_V",
    prompt: "supply voltage range (V)",
    labels: ["supply voltage"],
    targetUnit: "V",
  },
  {
    key: "quiescent_current_uA",
    prompt: "quiescent current (uA)",
    labels: ["quiescent current", "supply current"],
    targetUnit: "uA",
  },
  {
    key: "pin_input_leakage_uA",
    prompt: "per-pin input leakage current (uA)",
    labels: ["input leakage", "leakage current"],
    targetUnit: "uA",
  },
  {
    key: "abs_max_vin_V",
    prompt: "absolute maximum input voltage (V)",
    labels: ["absolute maximum input voltage", "abs max input", "maximum voltage"],
    targetUnit: "V",
  },
  {
    key: "recommended_pullup_ohm",
    prompt: "recommended pull-up resistance (ohm)",
    labels: ["pull-up resistance", "pullup resistance", "pull-up resistor"],
    targetUnit: "ohm",
  },
];

/**
 * Resolve a raw extractor field label (or extractor-suggested key) to a
 * FieldSpec. Returns undefined for fields no spec consumes; such fields are
 * stored but never required for a verdict.
 */
export function resolveFieldSpec(
  rawFieldLabel: string,
  specs: FieldSpec[] = DEFAULT_FIELD_SPECS,
): FieldSpec | undefined {
  const label = rawFieldLabel.trim().toLowerCase();
  // Exact key match first (extractor may echo the canonical key).
  const byKey = specs.find((s) => s.key === rawFieldLabel);
  if (byKey) return byKey;
  return specs.find((s) => s.labels.some((l) => label.includes(l.toLowerCase())));
}
