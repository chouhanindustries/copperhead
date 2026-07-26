import { describe, expect, it } from "vitest";
import { parseRegistry, RegistryError } from "../core/registry";

const STARTER = JSON.stringify({
  part: "demo-part",
  facts: [],
  constraints: [
    {
      id: "sleep_current_budget",
      description: "board sleeps within 25 uA",
      kind: "budget_sum",
      limit: 25,
      unit: "uA",
      affects: ["pin_input_leakage_uA"],
      source: "board SPEC sleep budget",
    },
    {
      id: "rail_voltage_max",
      description: "no pin driven above the 3.3V rail abs-max",
      kind: "max",
      limit: 3.3,
      unit: "V",
      affects: ["abs_max_vin_V"],
      source: "board SPEC rail",
    },
  ],
});

describe("registry loading (AC-5.1)", () => {
  it("parses the starter registry with a budget_sum and a max constraint", () => {
    const registry = parseRegistry(STARTER);
    const budget = registry.constraints.find((c) => c.kind === "budget_sum");
    const max = registry.constraints.find((c) => c.kind === "max");
    expect(budget).toMatchObject({ id: "sleep_current_budget", limit: 25, unit: "uA" });
    expect(max).toMatchObject({ id: "rail_voltage_max", unit: "V" });
  });

  it("round-trips a registry containing persisted facts", () => {
    const withFacts = JSON.parse(STARTER);
    withFacts.facts = [
      {
        key: "pin_input_leakage_uA",
        rawField: "Input leakage current",
        value: 33,
        unit: "uA",
        confidence: 0.95,
        status: "trusted",
        source: { page: 2, bbox: { page: 2, x: 0.1, y: 0.2, width: 0.3, height: 0.05 }, snippet: "Input leakage current 0.033 mA" },
      },
    ];
    const registry = parseRegistry(JSON.stringify(withFacts));
    expect(registry.facts).toHaveLength(1);
    expect(registry.facts[0]?.status).toBe("trusted");
  });
});

describe("malformed registries fail closed (AC-5.2)", () => {
  it.each([
    ["invalid JSON", "{ nope"],
    ["non-object root", "[1, 2]"],
    ["missing part", JSON.stringify({ facts: [], constraints: [] })],
    ["bad constraint kind", JSON.stringify({ part: "p", facts: [], constraints: [{ id: "x", description: "", kind: "vibes", limit: 1, unit: "uA", affects: ["a"], source: "" }] })],
    ["non-numeric limit", JSON.stringify({ part: "p", facts: [], constraints: [{ id: "x", description: "", kind: "max", limit: "many", unit: "V", affects: ["a"], source: "" }] })],
    ["empty affects", JSON.stringify({ part: "p", facts: [], constraints: [{ id: "x", description: "", kind: "max", limit: 1, unit: "V", affects: [], source: "" }] })],
    ["trusted fact without bbox", JSON.stringify({ part: "p", facts: [{ key: "k", rawField: "r", value: 1, confidence: 0.9, status: "trusted", source: { page: 1 } }], constraints: [] })],
    ["confidence out of range", JSON.stringify({ part: "p", facts: [{ key: "k", rawField: "r", value: 1, confidence: 1.5, status: "hold", holdReason: "x", source: { page: 1 } }], constraints: [] })],
  ])("rejects %s with a RegistryError", (_name, text) => {
    expect(() => parseRegistry(text)).toThrow(RegistryError);
  });
});
