import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { RegistryStore } from "../adapters/registry-store";
import { RegistryError } from "../core/registry";
import { heldFact, trustedFact, bbox, sleepBudget } from "./helpers";

let path: string;
let store: RegistryStore;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "intake-registry-"));
  path = join(dir, "constraints.json");
  writeFileSync(
    path,
    JSON.stringify({ part: "demo-part", facts: [], constraints: [sleepBudget()] }),
  );
  store = new RegistryStore(path);
});

describe("fact persistence (AC-8.1)", () => {
  it("writes trusted facts with value, confidence, and source", () => {
    store.persistFacts([trustedFact()]);
    const registry = store.load();
    expect(registry.facts).toHaveLength(1);
    expect(registry.facts[0]).toMatchObject({
      key: "pin_input_leakage_uA",
      value: 33,
      confidence: 0.95,
      status: "trusted",
    });
    expect(registry.facts[0]?.source.bbox).toBeDefined();
  });

  it("upserts by key instead of duplicating", () => {
    store.persistFacts([trustedFact()]);
    store.persistFacts([trustedFact({ value: 12 })]);
    const registry = store.load();
    expect(registry.facts).toHaveLength(1);
    expect(registry.facts[0]?.value).toBe(12);
  });

  it("round-trips through parseRegistry validation", () => {
    store.persistFacts([trustedFact(), heldFact({ key: "abs_max_vin_V" })]);
    expect(() => store.load()).not.toThrow();
  });
});

describe("correction propagation (AC-9.1)", () => {
  it("promotes a held-for-confidence fact (with bbox) to trusted on correction", () => {
    store.persistFacts([
      heldFact({
        source: { page: 2, bbox: bbox(2), snippet: "Input leakage current 0.033 mA" },
      }),
    ]);
    const registry = store.correctFact("pin_input_leakage_uA", 20);
    expect(registry.facts[0]).toMatchObject({
      value: 20,
      confidence: 1.0,
      status: "trusted",
    });
  });

  it("keeps an unsourced held fact held after correction", () => {
    store.persistFacts([heldFact()]);
    const registry = store.correctFact("pin_input_leakage_uA", 20);
    expect(registry.facts[0]).toMatchObject({ value: 20, status: "hold" });
  });

  it("throws on correcting a fact that does not exist", () => {
    expect(() => store.correctFact("nonexistent_key", 1)).toThrow(RegistryError);
  });
});

describe("fail-closed loading", () => {
  it("throws RegistryError on a missing file", () => {
    const missing = new RegistryStore(join(tmpdir(), "does-not-exist", "constraints.json"));
    expect(() => missing.load()).toThrow(RegistryError);
  });

  it("throws RegistryError on malformed content", () => {
    writeFileSync(path, "{ nope");
    expect(() => store.load()).toThrow(RegistryError);
  });
});
