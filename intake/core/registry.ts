// Registry parsing and validation. Fail closed: a malformed registry is a
// typed error, never a default-empty registry. Pure module: no I/O; the
// caller (RegistryStore) reads the file and passes the JSON text in.

import { Constraint, ConstraintKind, ExtractedFact, Registry } from "./model";

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

const CONSTRAINT_KINDS: ConstraintKind[] = ["budget_sum", "max", "min", "equality"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConstraint(raw: unknown, index: number): Constraint {
  if (!isRecord(raw)) throw new RegistryError(`constraints[${index}] is not an object`);
  const { id, description, kind, limit, unit, affects, source } = raw;
  if (typeof id !== "string" || id.length === 0)
    throw new RegistryError(`constraints[${index}].id must be a non-empty string`);
  if (typeof description !== "string")
    throw new RegistryError(`constraint "${id}": description must be a string`);
  if (typeof kind !== "string" || !CONSTRAINT_KINDS.includes(kind as ConstraintKind))
    throw new RegistryError(
      `constraint "${id}": kind must be one of ${CONSTRAINT_KINDS.join(", ")}`,
    );
  if (typeof limit !== "number" || !Number.isFinite(limit))
    throw new RegistryError(`constraint "${id}": limit must be a finite number`);
  if (typeof unit !== "string" || unit.length === 0)
    throw new RegistryError(`constraint "${id}": unit must be a non-empty string`);
  if (!Array.isArray(affects) || affects.some((a) => typeof a !== "string") || affects.length === 0)
    throw new RegistryError(`constraint "${id}": affects must be a non-empty string array`);
  if (typeof source !== "string")
    throw new RegistryError(`constraint "${id}": source must be a string`);
  return {
    id,
    description,
    kind: kind as ConstraintKind,
    limit,
    unit,
    affects: affects as string[],
    source,
  };
}

function parseFact(raw: unknown, index: number): ExtractedFact {
  if (!isRecord(raw)) throw new RegistryError(`facts[${index}] is not an object`);
  const { key, rawField, value, confidence, status, source } = raw;
  if (typeof key !== "string" || key.length === 0)
    throw new RegistryError(`facts[${index}].key must be a non-empty string`);
  if (typeof rawField !== "string")
    throw new RegistryError(`fact "${key}": rawField must be a string`);
  if (typeof value !== "number" && typeof value !== "string")
    throw new RegistryError(`fact "${key}": value must be a number or string`);
  if (typeof confidence !== "number" || confidence < 0 || confidence > 1)
    throw new RegistryError(`fact "${key}": confidence must be in [0, 1]`);
  if (status !== "trusted" && status !== "hold")
    throw new RegistryError(`fact "${key}": status must be "trusted" or "hold"`);
  if (!isRecord(source) || typeof source.page !== "number")
    throw new RegistryError(`fact "${key}": source.page is required`);

  if (status === "trusted") {
    const bbox = source.bbox;
    if (!isRecord(bbox) || typeof source.snippet !== "string")
      throw new RegistryError(
        `fact "${key}": a trusted fact requires source.bbox and source.snippet`,
      );
    // Re-parsing keeps the structural guarantee: trust never round-trips
    // through the registry without provenance intact.
    return raw as unknown as ExtractedFact;
  }
  if (typeof raw.holdReason !== "string")
    throw new RegistryError(`fact "${key}": a held fact requires holdReason`);
  return raw as unknown as ExtractedFact;
}

/** Parse registry JSON text. Throws RegistryError on any malformation. */
export function parseRegistry(jsonText: string): Registry {
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch (err) {
    throw new RegistryError(
      `registry is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isRecord(data)) throw new RegistryError("registry root must be an object");
  if (typeof data.part !== "string")
    throw new RegistryError("registry.part must be a string");
  if (!Array.isArray(data.facts)) throw new RegistryError("registry.facts must be an array");
  if (!Array.isArray(data.constraints))
    throw new RegistryError("registry.constraints must be an array");

  return {
    part: data.part,
    facts: data.facts.map(parseFact),
    constraints: data.constraints.map(parseConstraint),
  };
}
