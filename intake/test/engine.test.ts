import { describe, expect, it } from "vitest";
import { evaluate } from "../core/engine";
import { ChangeDescriptor } from "../core/model";
import { heldFact, railMax, sleepBudget, trustedFact, bbox } from "./helpers";

const pullUpChange: ChangeDescriptor = {
  kind: "add_component",
  label: "add 100k pull-up on GPIO12",
  contributions: [{ factKey: "pin_input_leakage_uA" }],
};

const railChange: ChangeDescriptor = {
  kind: "connect_rail",
  label: "drive this pin from the 5V rail",
  contributions: [{ factKey: "abs_max_vin_V", value: 5, unit: "V" }],
};

describe("budget refusal (AC-6.1)", () => {
  it("sums magnitudes: a signed input current (IIL = -0.4 mA) still busts the budget", () => {
    const iil = trustedFact({ value: -400 });
    const { verdict } = evaluate(pullUpChange, [iil], [sleepBudget()]);
    expect(verdict.decision).toBe("REFUSE");
    expect(verdict.computed).toMatchObject({ result: 400, limit: 25, unit: "uA" });
  });

  it("refuses 33uA against a 25uA budget_sum, citing both lines", () => {
    const { verdict } = evaluate(pullUpChange, [trustedFact()], [sleepBudget()]);
    expect(verdict.decision).toBe("REFUSE");
    expect(verdict.computed).toMatchObject({ result: 33, limit: 25, unit: "uA" });
    expect(verdict.computed?.expression).toContain("33 uA > 25 uA");
    expect(verdict.citedFact?.key).toBe("pin_input_leakage_uA");
    expect(verdict.citedConstraint?.id).toBe("sleep_current_budget");
  });
});

describe("abs-max refusal (AC-6.2)", () => {
  it("refuses 5V applied to a 3.6V abs-max part, citing both lines", () => {
    const absMax = trustedFact({
      key: "abs_max_vin_V",
      rawField: "Absolute maximum input voltage",
      value: 3.6,
      unit: "V",
      source: { page: 2, bbox: bbox(2), snippet: "Absolute maximum input voltage 3.6 V" },
    });
    const { verdict } = evaluate(railChange, [absMax], [railMax()]);
    expect(verdict.decision).toBe("REFUSE");
    expect(verdict.computed).toMatchObject({ result: 5, limit: 3.6, unit: "V" });
    expect(verdict.citedFact?.key).toBe("abs_max_vin_V");
    expect(verdict.citedConstraint?.id).toBe("rail_voltage_max");
  });
});

describe("approval (AC-6.3)", () => {
  it("approves a change within all constraints with all trusted facts", () => {
    const lowLeakage = trustedFact({ value: 4 });
    const { verdict } = evaluate(pullUpChange, [lowLeakage], [sleepBudget()]);
    expect(verdict.decision).toBe("APPROVE");
  });
});

describe("determinism (AC-6.4)", () => {
  it("returns an identical verdict on three identical evaluations", () => {
    const runs = [1, 2, 3].map(() =>
      evaluate(pullUpChange, [trustedFact()], [sleepBudget()]),
    );
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });
});

describe("HOLD dominance (AC-4.2)", () => {
  it("holds when a held fact is the deciding input, naming the field", () => {
    const { verdict } = evaluate(pullUpChange, [heldFact()], [sleepBudget()]);
    expect(verdict.decision).toBe("HOLD");
    expect(verdict.reason).toContain("pin_input_leakage_uA");
    expect(verdict.reason).not.toContain("APPROVE");
  });

  it("never emits APPROVE or REFUSE from held facts even when the numbers would pass", () => {
    const passing = heldFact({ value: 1 });
    const { verdict } = evaluate(pullUpChange, [passing], [sleepBudget()]);
    expect(verdict.decision).toBe("HOLD");
  });
});

describe("fail-closed edges", () => {
  it("holds when the required fact is missing entirely", () => {
    const { verdict } = evaluate(pullUpChange, [], [sleepBudget()]);
    expect(verdict.decision).toBe("HOLD");
    expect(verdict.reason).toContain("pin_input_leakage_uA");
  });

  it("holds when no constraint consumes the change's keys", () => {
    const { verdict } = evaluate(
      { kind: "add_component", label: "add decoupling cap", contributions: [{ factKey: "esr_ohm" }] },
      [trustedFact()],
      [sleepBudget()],
    );
    expect(verdict.decision).toBe("HOLD");
  });

  it("holds on a non-numeric deciding fact", () => {
    const oddFact = trustedFact({ value: "1.8 to 3.6" });
    const { verdict } = evaluate(pullUpChange, [oddFact], [sleepBudget()]);
    expect(verdict.decision).toBe("HOLD");
  });
});

describe("cited refusal content (AC-7.1)", () => {
  it("one-sentence reason names measured value, limit, and deviation, with a specific fix", () => {
    const { verdict } = evaluate(pullUpChange, [trustedFact()], [sleepBudget()]);
    expect(verdict.reason).toContain("33 uA");
    expect(verdict.reason).toContain("25 uA");
    expect(verdict.reason).toContain("8 uA");
    expect((verdict.reason.match(/\./g) ?? []).length).toBe(1);
    expect(verdict.proposedFix).toBeTruthy();
  });
});
