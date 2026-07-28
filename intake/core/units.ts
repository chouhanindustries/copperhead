// Unit normalization: table-driven conversions to canonical units.
// Pure module: no I/O.

export class UnitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnitError";
  }
}

/** Conversion factors into the canonical unit of each family. */
const FAMILIES: Record<string, { canonical: string; factors: Record<string, number> }> = {
  current_uA: {
    canonical: "uA",
    factors: {
      pA: 1e-6,
      nA: 1e-3,
      uA: 1,
      "µA": 1,
      μA: 1,
      mA: 1e3,
      A: 1e6,
    },
  },
  voltage_V: {
    canonical: "V",
    factors: {
      mV: 1e-3,
      V: 1,
      kV: 1e3,
    },
  },
  resistance_ohm: {
    canonical: "ohm",
    factors: {
      ohm: 1,
      "Ω": 1,
      kohm: 1e3,
      "kΩ": 1e3,
      k: 1e3,
      Mohm: 1e6,
      "MΩ": 1e6,
      M: 1e6,
    },
  },
};

function familyOf(unit: string): { canonical: string; factor: number } | undefined {
  for (const family of Object.values(FAMILIES)) {
    const factor = family.factors[unit];
    if (factor !== undefined) return { canonical: family.canonical, factor };
  }
  // Case-insensitive fallback for common datasheet casing ("MA", "ua", "OHM").
  const lower = unit.toLowerCase();
  for (const family of Object.values(FAMILIES)) {
    for (const [candidate, factor] of Object.entries(family.factors)) {
      if (candidate.toLowerCase() === lower) {
        return { canonical: family.canonical, factor };
      }
    }
  }
  return undefined;
}

/**
 * Convert a value in `unit` to `targetUnit`. Both must belong to the same
 * family. Throws UnitError on unknown units or cross-family conversion.
 */
export function convert(value: number, unit: string, targetUnit: string): number {
  const from = familyOf(unit.trim());
  const to = familyOf(targetUnit.trim());
  if (!from) throw new UnitError(`unknown unit: ${unit}`);
  if (!to) throw new UnitError(`unknown unit: ${targetUnit}`);
  if (from.canonical !== to.canonical) {
    throw new UnitError(`cannot convert ${unit} to ${targetUnit}`);
  }
  return (value * from.factor) / to.factor;
}

/** True if `unit` is a recognized unit convertible to `targetUnit`. */
export function isConvertible(unit: string, targetUnit: string): boolean {
  const from = familyOf(unit.trim());
  const to = familyOf(targetUnit.trim());
  return from !== undefined && to !== undefined && from.canonical === to.canonical;
}
