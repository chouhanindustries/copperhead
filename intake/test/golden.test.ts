// Golden tests GT-1..GT-5: the demo scenarios, end to end and offline.
// A synthetic demo part exercises the exact SPEC values (33 uA leakage vs a
// 25 uA budget, 3.6 V abs-max vs a 5 V rail); the same tests re-run against
// real-part fixtures once those are generated live (task 7.2).

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { digitiseCacheKey, extractCacheKey, JsonCache } from "../adapters/cache";
import { FixtureDigitisationProvider, FixtureExtractor } from "../adapters/fixtures";
import { ingest, IngestDeps } from "../adapters/ingest";
import { RegistryStore } from "../adapters/registry-store";
import { evaluate } from "../core/engine";
import { buildManifest, reproduces } from "../core/manifest";
import { DEFAULT_FIELD_SPECS } from "../core/fields";
import { ChangeDescriptor } from "../core/model";
import { DigitisedPage, RawExtractedField } from "../core/pipeline";
import { DocumentInput } from "../ports/digitisation";
import { bbox } from "./helpers";

const doc: DocumentInput = {
  fileName: "demo-io-expander.pdf",
  bytes: Buffer.from("synthetic demo-io-expander datasheet"),
};

const PAGES: DigitisedPage[] = [
  {
    page: 1,
    text: "DEMO-IO-EXPANDER. Absolute maximum ratings. Input voltage VIN max 3.6 V. Supply voltage 1.65 to 3.6 V.",
    regions: [
      { text: "Input voltage VIN max 3.6 V", bbox: bbox(1, { y: 0.3 }) },
      { text: "Supply voltage 1.65 to 3.6 V", bbox: bbox(1, { y: 0.4 }) },
    ],
  },
  {
    page: 2,
    text: "Electrical characteristics. Input leakage current 0.033 mA max. Quiescent current 1.5 uA (1) footnote: at 25 C only.",
    regions: [
      { text: "Input leakage current 0.033 mA max", bbox: bbox(2, { y: 0.2 }) },
      { text: "Quiescent current 1.5 uA (1)", bbox: bbox(2, { y: 0.3 }) },
    ],
  },
];

const RAW_FIELDS: RawExtractedField[] = [
  {
    field: "per-pin input leakage current (uA)",
    value: 0.033,
    unit: "mA",
    page: 2,
    snippet: "Input leakage current 0.033 mA",
    confidence: 0.93,
  },
  {
    field: "absolute maximum input voltage (V)",
    value: 3.6,
    unit: "V",
    page: 1,
    snippet: "Input voltage VIN max 3.6 V",
    confidence: 0.91,
  },
  {
    field: "quiescent current (uA)",
    value: 1.5,
    unit: "uA",
    page: 2,
    snippet: "Quiescent current 1.5 uA (1)",
    footnoteQualified: true,
    confidence: 0.88,
  },
];

const SEED = {
  part: "DEMO-IO-EXPANDER",
  facts: [],
  constraints: [
    {
      id: "sleep_current_budget",
      description: "board sleeps within 25 uA",
      kind: "budget_sum",
      limit: 25,
      unit: "uA",
      affects: ["pin_input_leakage_uA", "quiescent_current_uA"],
      source: "board SPEC sleep budget",
    },
    {
      id: "rail_voltage_max",
      description: "no pin driven above the rail abs-max",
      kind: "max",
      limit: 5,
      unit: "V",
      affects: ["abs_max_vin_V"],
      source: "board SPEC rail",
    },
  ],
};

const pullUp: ChangeDescriptor = {
  kind: "add_component",
  label: "add 100k pull-up on a sleeping GPIO",
  contributions: [{ factKey: "pin_input_leakage_uA" }],
};

const driveFrom5V: ChangeDescriptor = {
  kind: "connect_rail",
  label: "drive this pin from the 5V rail",
  contributions: [{ factKey: "abs_max_vin_V", value: 5, unit: "V" }],
};

const sleepCurrentCheck: ChangeDescriptor = {
  kind: "add_component",
  label: "keep the part powered in sleep",
  contributions: [{ factKey: "quiescent_current_uA" }],
};

let deps: IngestDeps;
let store: RegistryStore;
let extractCalls: number;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "intake-golden-"));
  const cache = new JsonCache(join(dir, "cache"));
  cache.write(digitiseCacheKey(doc.bytes), PAGES);
  cache.write(extractCacheKey(doc.bytes, DEFAULT_FIELD_SPECS), RAW_FIELDS);

  extractCalls = 0;
  const fixtureExtractor = new FixtureExtractor(cache, doc.bytes);
  deps = {
    cache,
    digitiser: new FixtureDigitisationProvider(cache),
    extractor: {
      modelId: fixtureExtractor.modelId,
      extract: async (pages, specs) => {
        extractCalls++;
        return fixtureExtractor.extract(pages, specs);
      },
    },
  };

  const registryPath = join(dir, "constraints.json");
  writeFileSync(registryPath, JSON.stringify(SEED));
  store = new RegistryStore(registryPath);
});

describe("GT-1: pull-up refused against the sleep budget", () => {
  it("refuses 33 uA > 25 uA citing the leakage line and the budget line, with the internal pull-up fix", async () => {
    const { facts } = await ingest(doc, deps);
    const { verdict, checksRun, factsUsed } = evaluate(pullUp, facts, store.load().constraints);

    expect(verdict.decision).toBe("REFUSE");
    expect(verdict.computed).toMatchObject({ limit: 25, unit: "uA" });
    expect(verdict.computed?.result).toBeCloseTo(33, 9);
    expect(verdict.citedFact?.key).toBe("pin_input_leakage_uA");
    expect(verdict.citedFact?.source.bbox).toBeDefined();
    expect(verdict.citedConstraint?.id).toBe("sleep_current_budget");
    expect(verdict.proposedFix).toContain("internal pull-up");

    store.persistFacts(factsUsed);
    const manifest = buildManifest({
      timestampISO: "2026-07-26T00:00:00.000Z",
      part: "DEMO-IO-EXPANDER",
      descriptor: pullUp,
      constraints: SEED.constraints as never,
      checksRun,
      factsUsed,
      verdict,
      digitiseModel: deps.digitiser.modelId,
      extractorModel: deps.extractor.modelId,
    });
    expect(reproduces(manifest)).toBe(true);
  });
});

describe("GT-2: 5V rail refused against the 3.6V abs-max", () => {
  it("refuses 5 V > 3.6 V citing both lines", async () => {
    const { facts } = await ingest(doc, deps);
    const { verdict } = evaluate(driveFrom5V, facts, store.load().constraints);

    expect(verdict.decision).toBe("REFUSE");
    expect(verdict.computed).toMatchObject({ result: 5, limit: 3.6, unit: "V" });
    expect(verdict.citedFact?.key).toBe("abs_max_vin_V");
    expect(verdict.citedConstraint?.id).toBe("rail_voltage_max");
  });
});

describe("GT-3: footnote-qualified value is held, never decides", () => {
  it("returns HOLD naming the field to re-check", async () => {
    const { facts } = await ingest(doc, deps);
    const quiescent = facts.find((f) => f.key === "quiescent_current_uA");
    expect(quiescent?.status).toBe("hold");

    const { verdict, factsUsed } = evaluate(sleepCurrentCheck, facts, store.load().constraints);
    expect(verdict.decision).toBe("HOLD");
    expect(verdict.reason).toContain("quiescent_current_uA");
    store.persistFacts(factsUsed.length ? factsUsed : facts);
  });
});

describe("GT-4: correcting the held value recomputes the verdict live", () => {
  it("promotes the corrected fact and produces a decisive verdict without re-extraction", async () => {
    const { facts } = await ingest(doc, deps);
    store.persistFacts(facts);
    expect(extractCalls).toBe(0);

    const before = evaluate(sleepCurrentCheck, store.load().facts, store.load().constraints);
    expect(before.verdict.decision).toBe("HOLD");

    const registry = store.correctFact("quiescent_current_uA", 1.5);
    const after = evaluate(sleepCurrentCheck, registry.facts, registry.constraints);
    expect(after.verdict.decision).toBe("APPROVE");
    expect(extractCalls).toBe(0);
  });
});

describe("GT-5: a second change reuses stored facts with no new extraction", () => {
  it("evaluates from the registry without touching the extractor", async () => {
    const first = await ingest(doc, deps);
    store.persistFacts(first.facts);
    const callsAfterFirst = extractCalls;

    const registry = store.load();
    expect(store.hasFacts(["pin_input_leakage_uA", "abs_max_vin_V"])).toBe(true);
    const { verdict } = evaluate(driveFrom5V, registry.facts, registry.constraints);
    expect(verdict.decision).toBe("REFUSE");
    expect(extractCalls).toBe(callsAfterFirst);

    const again = await ingest(doc, deps);
    expect(again.facts.length).toBeGreaterThan(0);
    expect(extractCalls).toBe(callsAfterFirst);
  });
});
