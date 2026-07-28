import { describe, expect, it } from "vitest";
import { evaluate } from "../core/engine";
import { buildManifest, reproduces } from "../core/manifest";
import { ChangeDescriptor } from "../core/model";
import { sleepBudget, trustedFact } from "./helpers";

const descriptor: ChangeDescriptor = {
  kind: "add_component",
  label: "add 100k pull-up on GPIO12",
  contributions: [{ factKey: "pin_input_leakage_uA" }],
};

describe("verification manifest (AC-11.1)", () => {
  it("contains checksRun, factsUsed with sources, the verdict, and model ids", () => {
    const facts = [trustedFact()];
    const constraints = [sleepBudget()];
    const { verdict, checksRun, factsUsed } = evaluate(descriptor, facts, constraints);
    const manifest = buildManifest({
      timestampISO: "2026-07-26T00:00:00.000Z",
      part: "demo-part",
      descriptor,
      constraints,
      checksRun,
      factsUsed,
      verdict,
      digitiseModel: "sarvam-vision",
      extractorModel: "claude-sonnet-5",
    });
    expect(manifest.checksRun).toContain("sleep_current_budget");
    expect(manifest.factsUsed[0]?.source.page).toBe(2);
    expect(manifest.verdict.decision).toBe("REFUSE");
    expect(manifest.extraction).toEqual({
      digitiseModel: "sarvam-vision",
      extractorModel: "claude-sonnet-5",
    });
  });

  it("is reproducible: re-running the engine on stored inputs yields the identical verdict", () => {
    const facts = [trustedFact()];
    const constraints = [sleepBudget()];
    const { verdict, checksRun, factsUsed } = evaluate(descriptor, facts, constraints);
    const manifest = buildManifest({
      timestampISO: "2026-07-26T00:00:00.000Z",
      part: "demo-part",
      descriptor,
      constraints,
      checksRun,
      factsUsed,
      verdict,
      digitiseModel: "sarvam-vision",
      extractorModel: "claude-sonnet-5",
    });
    expect(reproduces(manifest)).toBe(true);
  });

  it("detects a tampered manifest", () => {
    const facts = [trustedFact()];
    const constraints = [sleepBudget()];
    const { verdict, checksRun, factsUsed } = evaluate(descriptor, facts, constraints);
    const manifest = buildManifest({
      timestampISO: "2026-07-26T00:00:00.000Z",
      part: "demo-part",
      descriptor,
      constraints,
      checksRun,
      factsUsed,
      verdict: { ...verdict, decision: "APPROVE" },
      digitiseModel: "sarvam-vision",
      extractorModel: "claude-sonnet-5",
    });
    expect(reproduces(manifest)).toBe(false);
  });
});
