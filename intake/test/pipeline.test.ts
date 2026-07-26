import { describe, expect, it } from "vitest";
import { assembleFacts } from "../core/pipeline";
import { convert, UnitError } from "../core/units";
import { digitisedPage, firstFact, rawField, bbox } from "./helpers";

describe("unit normalization (AC-2.1)", () => {
  it("normalizes 0.033 mA to { key: pin_input_leakage_uA, value: 33, unit: uA }", () => {
    const fact = firstFact([rawField()], [digitisedPage()]);
    expect(fact).toMatchObject({
      key: "pin_input_leakage_uA",
      value: expect.closeTo(33, 9),
      unit: "uA",
      status: "trusted",
    });
  });

  it("converts across the current family", () => {
    expect(convert(1, "A", "uA")).toBe(1e6);
    expect(convert(500, "nA", "uA")).toBe(0.5);
    expect(convert(0.5, "µA", "uA")).toBe(0.5);
  });

  it("refuses cross-family conversion", () => {
    expect(() => convert(1, "mA", "V")).toThrow(UnitError);
  });
});

describe("unconsumed fields (AC-2.2)", () => {
  it("stores fields no spec consumes without crashing", () => {
    const raw = rawField({
      field: "Junction temperature range",
      value: "-40 to 125",
      unit: "C",
      snippet: "Junction temperature range -40 to 125 C",
    });
    const page = digitisedPage({
      text: "Junction temperature range -40 to 125 C",
      regions: [{ text: "Junction temperature range -40 to 125 C", bbox: bbox(2) }],
    });
    const fact = firstFact([raw], [page]);
    expect(fact.key).toBe("Junction temperature range");
    expect(fact.value).toBe("-40 to 125");
  });
});

describe("provenance (AC-3.1)", () => {
  it("trusted facts always carry page, bbox, and snippet", () => {
    const fact = firstFact([rawField()], [digitisedPage()]);
    expect(fact.status).toBe("trusted");
    expect(fact.source.page).toBe(2);
    expect(fact.source.bbox).toBeDefined();
    expect(fact.source.snippet).toBeDefined();
  });

  it("holds a fact whose snippet matches page text but no region", () => {
    const page = digitisedPage({
      text: "Input leakage current 0.033 mA",
      regions: [],
    });
    const fact = firstFact([rawField()], [page]);
    expect(fact.status).toBe("hold");
    expect(fact.source.bbox).toBeUndefined();
  });

  it("holds a fact whose page is not in the digitised output", () => {
    const fact = firstFact([rawField({ page: 9 })], [digitisedPage()]);
    expect(fact.status).toBe("hold");
  });
});

describe("snippet verification (design D9)", () => {
  it("holds a fact whose snippet does not occur in the digitised text, regardless of confidence", () => {
    const raw = rawField({ snippet: "Input leakage current 0.099 mA", confidence: 0.99 });
    const fact = firstFact([raw], [digitisedPage()]);
    expect(fact.status).toBe("hold");
    expect((fact as { holdReason: string }).holdReason).toContain("snippet not found");
  });

  it("matches snippets across whitespace and case differences", () => {
    const raw = rawField({ snippet: "input   leakage\ncurrent 0.033 MA".replace("MA", "mA") });
    const fact = firstFact([raw], [digitisedPage()]);
    expect(fact.status).toBe("trusted");
  });

  it("survives unicode in snippets and regions", () => {
    const text = "Входной ток утечки 0.033 mA — таблица 5 μA";
    const page = digitisedPage({ text, regions: [{ text, bbox: bbox(2) }] });
    const raw = rawField({ snippet: "Входной ток утечки 0.033 mA" });
    const fact = firstFact([raw], [page]);
    expect(fact.status).toBe("trusted");
  });

  it("holds on an empty snippet", () => {
    const fact = firstFact([rawField({ snippet: "   " })], [digitisedPage()]);
    expect(fact.status).toBe("hold");
  });
});

describe("confidence gating (AC-4.1)", () => {
  it("holds any fact below 0.75", () => {
    const fact = firstFact([rawField({ confidence: 0.74 })], [digitisedPage()]);
    expect(fact.status).toBe("hold");
    expect((fact as { holdReason: string }).holdReason).toContain("below threshold");
  });

  it("trusts a fact at exactly 0.75", () => {
    const fact = firstFact([rawField({ confidence: 0.75 })], [digitisedPage()]);
    expect(fact.status).toBe("trusted");
  });

  it("holds a footnote-qualified fact at any confidence", () => {
    const fact = firstFact(
      [rawField({ footnoteQualified: true, confidence: 0.99 })],
      [digitisedPage()],
    );
    expect(fact.status).toBe("hold");
    expect((fact as { holdReason: string }).holdReason).toContain("footnote");
  });
});

describe("adversarial inputs", () => {
  it("handles the empty case", () => {
    expect(assembleFacts([], [])).toEqual([]);
  });

  it("handles many fields against one page deterministically", () => {
    const raws = Array.from({ length: 50 }, (_, i) =>
      rawField({ field: `Field ${i}`, snippet: "Input leakage current 0.033 mA" }),
    );
    const first = assembleFacts(raws, [digitisedPage()]);
    const second = assembleFacts(raws, [digitisedPage()]);
    expect(first).toEqual(second);
    expect(first).toHaveLength(50);
  });

  it("holds on an unconvertible printed unit instead of guessing", () => {
    const page = digitisedPage({
      text: "Input leakage current 33 furlongs",
      regions: [{ text: "Input leakage current 33 furlongs", bbox: bbox(2) }],
    });
    const raw = rawField({ value: 33, unit: "furlongs", snippet: "Input leakage current 33 furlongs" });
    const fact = firstFact([raw], [page]);
    expect(fact.status).toBe("hold");
    expect((fact as { holdReason: string }).holdReason).toContain("not convertible");
  });

  it("picks the first matching region when duplicates exist (deterministic)", () => {
    const region = { text: "Input leakage current 0.033 mA", bbox: bbox(2, { y: 0.1 }) };
    const dup = { text: "Input leakage current 0.033 mA", bbox: bbox(2, { y: 0.9 }) };
    const page = digitisedPage({ regions: [region, dup] });
    const fact = firstFact([rawField()], [page]);
    expect(fact.status).toBe("trusted");
    expect(fact.source.bbox?.y).toBe(0.1);
  });
});
