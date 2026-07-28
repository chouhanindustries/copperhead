// RegistryStore: load/save of constraints.json with atomic writes, plus the
// registry-memory operations (persist trusted facts, reuse, correction).
// The only module besides cache.ts that touches the filesystem.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ExtractedFact, Registry, TrustedFact, isTrusted } from "../core/model";
import { parseRegistry, RegistryError } from "../core/registry";

export class RegistryStore {
  constructor(private readonly path: string) {}

  /** Fail closed: a missing or malformed registry is an error, never a default. */
  load(): Registry {
    if (!existsSync(this.path)) {
      throw new RegistryError(`registry not found at ${this.path}`);
    }
    return parseRegistry(readFileSync(this.path, "utf8"));
  }

  save(registry: Registry): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(registry, null, 2));
    renameSync(tmp, this.path);
  }

  /**
   * Persist trusted facts after an APPROVE or REFUSE verdict (AC-8.1).
   * Upserts by fact key; held facts are stored too so corrections can find
   * them, but they never decide anything.
   */
  persistFacts(facts: ExtractedFact[]): Registry {
    const registry = this.load();
    for (const fact of facts) {
      const index = registry.facts.findIndex((f) => f.key === fact.key);
      if (index >= 0) registry.facts[index] = fact;
      else registry.facts.push(fact);
    }
    this.save(registry);
    return registry;
  }

  /** True when every requested fact key is already stored (AC-8.2 reuse check). */
  hasFacts(keys: string[]): boolean {
    const registry = this.load();
    return keys.every((key) => registry.facts.some((f) => f.key === key));
  }

  /**
   * Apply a user correction to a stored fact (AC-9.1). The corrected value
   * gets confidence 1.0. Status becomes trusted only when the original
   * source carries a verified bbox and snippet (e.g. a fact held for low
   * confidence or a footnote); a fact held for missing provenance stays
   * held; the user verified the value, not the location.
   */
  correctFact(key: string, value: number | string): Registry {
    const registry = this.load();
    const index = registry.facts.findIndex((f) => f.key === key);
    const fact = registry.facts[index];
    if (index < 0 || !fact) {
      throw new RegistryError(`no stored fact "${key}" to correct`);
    }

    if (isTrusted(fact) || (fact.source.bbox && fact.source.snippet)) {
      const corrected: TrustedFact = {
        key: fact.key,
        rawField: fact.rawField,
        value,
        confidence: 1.0,
        status: "trusted",
        source: {
          page: fact.source.page,
          bbox: fact.source.bbox!,
          snippet: fact.source.snippet!,
        },
      };
      if (fact.unit !== undefined) corrected.unit = fact.unit;
      registry.facts[index] = corrected;
    } else {
      registry.facts[index] = {
        ...fact,
        value,
        confidence: 1.0,
        status: "hold",
        holdReason: "user-corrected value, but the fact has no verified source; re-ingest for provenance",
      };
    }
    this.save(registry);
    return registry;
  }
}
