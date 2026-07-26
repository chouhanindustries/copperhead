// The verdict engine: pure, deterministic, fail-closed.
// No I/O, no clock, no randomness, no LLM. Given identical inputs it
// produces identical verdicts; anything uncertain or missing is a HOLD.

import {
  ChangeDescriptor,
  Constraint,
  Contribution,
  ExtractedFact,
  Verdict,
  isTrusted,
} from "./model";
import { convert, isConvertible } from "./units";

/** Deterministic, specific fix suggestions keyed by constraint kind and change label. */
function proposeFix(constraint: Constraint, changeLabel: string): string {
  if (constraint.kind === "budget_sum" && /pull[- ]?up/i.test(changeLabel)) {
    return "use the MCU internal pull-up instead of an external resistor (leakage stays within budget)";
  }
  if (constraint.kind === "budget_sum") {
    return `raise the resistor value or gate this load so its draw fits the ${constraint.limit} ${constraint.unit} budget`;
  }
  if (constraint.kind === "max") {
    return "insert a level shifter or drive the pin from a rail at or below the absolute maximum";
  }
  if (constraint.kind === "min") {
    return "raise the driving value to meet the documented minimum";
  }
  return "match the change to the documented value exactly";
}

function hold(change: string, reason: string, citedFact?: ExtractedFact): Verdict {
  const verdict: Verdict = { change, decision: "HOLD", reason };
  if (citedFact) verdict.citedFact = citedFact;
  return verdict;
}

interface Check {
  constraint: Constraint;
  contribution: Contribution;
  fact: ExtractedFact;
}

function toConstraintUnit(
  value: number,
  unit: string | undefined,
  constraint: Constraint,
): number | undefined {
  if (unit === undefined || unit === constraint.unit) return value;
  if (!isConvertible(unit, constraint.unit)) return undefined;
  return convert(value, unit, constraint.unit);
}

function evaluateCheck(change: string, check: Check): Verdict | undefined {
  const { constraint, contribution, fact } = check;

  if (!isTrusted(fact)) {
    return hold(
      change,
      `Cannot decide: re-check field "${fact.key}" (${fact.holdReason}); a held fact never produces an approval or refusal.`,
      fact,
    );
  }
  if (typeof fact.value !== "number") {
    return hold(
      change,
      `Cannot decide: fact "${fact.key}" has non-numeric value "${fact.value}"; re-check it before evaluating.`,
      fact,
    );
  }
  const factValue = toConstraintUnit(fact.value, fact.unit, constraint);
  if (factValue === undefined) {
    return hold(
      change,
      `Cannot decide: fact "${fact.key}" unit "${fact.unit}" is not comparable to ${constraint.unit}; re-check it.`,
      fact,
    );
  }

  switch (constraint.kind) {
    case "budget_sum": {
      // The change's draw against a summed budget. The magnitude is the
      // explicit contribution when given, otherwise the fact value itself
      // (e.g. the datasheet leakage figure is the added draw). Datasheets
      // print current direction as sign (IIL = -0.4 mA); a budget sums
      // magnitudes, so the draw is the absolute value.
      const raw = contribution.value ?? factValue;
      const converted = toConstraintUnit(raw, contribution.value !== undefined ? contribution.unit : constraint.unit, constraint);
      if (converted === undefined) return hold(change, `Cannot decide: contribution unit "${contribution.unit}" is not comparable to ${constraint.unit}.`, fact);
      const draw = Math.abs(converted);
      if (draw > constraint.limit) {
        return {
          change,
          decision: "REFUSE",
          reason: `Refused: the change draws ${draw} ${constraint.unit} against a ${constraint.limit} ${constraint.unit} budget (${constraint.description}), exceeding it by ${round(draw - constraint.limit)} ${constraint.unit}.`,
          citedFact: fact,
          citedConstraint: constraint,
          computed: {
            expression: `${draw} ${constraint.unit} > ${constraint.limit} ${constraint.unit}`,
            result: draw,
            limit: constraint.limit,
            unit: constraint.unit,
          },
          proposedFix: proposeFix(constraint, change),
        };
      }
      return undefined;
    }
    case "max": {
      // The applied value (e.g. rail voltage) must not exceed the ceiling.
      // The ceiling is the datasheet fact when present (abs-max), bounded by
      // the constraint's own limit.
      if (contribution.value === undefined) {
        return hold(change, `Cannot decide: the change gives no applied value for "${fact.key}".`, fact);
      }
      const applied = toConstraintUnit(contribution.value, contribution.unit, constraint);
      if (applied === undefined) return hold(change, `Cannot decide: contribution unit "${contribution.unit}" is not comparable to ${constraint.unit}.`, fact);
      const ceiling = Math.min(factValue, constraint.limit);
      if (applied > ceiling) {
        return {
          change,
          decision: "REFUSE",
          reason: `Refused: the change applies ${applied} ${constraint.unit} where the documented maximum is ${ceiling} ${constraint.unit} (${constraint.description}), exceeding it by ${round(applied - ceiling)} ${constraint.unit}.`,
          citedFact: fact,
          citedConstraint: constraint,
          computed: {
            expression: `${applied} ${constraint.unit} > ${ceiling} ${constraint.unit}`,
            result: applied,
            limit: ceiling,
            unit: constraint.unit,
          },
          proposedFix: proposeFix(constraint, change),
        };
      }
      return undefined;
    }
    case "min": {
      if (contribution.value === undefined) {
        return hold(change, `Cannot decide: the change gives no applied value for "${fact.key}".`, fact);
      }
      const applied = toConstraintUnit(contribution.value, contribution.unit, constraint);
      if (applied === undefined) return hold(change, `Cannot decide: contribution unit "${contribution.unit}" is not comparable to ${constraint.unit}.`, fact);
      const floor = Math.max(factValue, constraint.limit);
      if (applied < floor) {
        return {
          change,
          decision: "REFUSE",
          reason: `Refused: the change applies ${applied} ${constraint.unit} where the documented minimum is ${floor} ${constraint.unit} (${constraint.description}), short by ${round(floor - applied)} ${constraint.unit}.`,
          citedFact: fact,
          citedConstraint: constraint,
          computed: {
            expression: `${applied} ${constraint.unit} < ${floor} ${constraint.unit}`,
            result: applied,
            limit: floor,
            unit: constraint.unit,
          },
          proposedFix: proposeFix(constraint, change),
        };
      }
      return undefined;
    }
    case "equality": {
      if (contribution.value === undefined) {
        return hold(change, `Cannot decide: the change gives no applied value for "${fact.key}".`, fact);
      }
      const applied = toConstraintUnit(contribution.value, contribution.unit, constraint);
      if (applied === undefined) return hold(change, `Cannot decide: contribution unit "${contribution.unit}" is not comparable to ${constraint.unit}.`, fact);
      if (applied !== factValue) {
        return {
          change,
          decision: "REFUSE",
          reason: `Refused: the change applies ${applied} ${constraint.unit} where the documented value is exactly ${factValue} ${constraint.unit} (${constraint.description}).`,
          citedFact: fact,
          citedConstraint: constraint,
          computed: {
            expression: `${applied} ${constraint.unit} != ${factValue} ${constraint.unit}`,
            result: applied,
            limit: factValue,
            unit: constraint.unit,
          },
          proposedFix: proposeFix(constraint, change),
        };
      }
      return undefined;
    }
  }
}

/**
 * Evaluate a proposed change against facts and constraints.
 *
 * Only constraints whose `affects` intersect the change's contribution keys
 * are evaluated. Constraint order in the registry decides citation order,
 * making the whole evaluation deterministic. Fail-closed rules: a missing
 * fact, a held fact, a non-numeric fact, or an incomparable unit is a HOLD.
 */
export function evaluate(
  descriptor: ChangeDescriptor,
  facts: ExtractedFact[],
  constraints: Constraint[],
): { verdict: Verdict; checksRun: string[]; factsUsed: ExtractedFact[] } {
  const change = descriptor.label;
  const checksRun: string[] = [];
  const factsUsed: ExtractedFact[] = [];

  for (const constraint of constraints) {
    for (const contribution of descriptor.contributions) {
      if (!constraint.affects.includes(contribution.factKey)) continue;
      checksRun.push(constraint.id);

      const fact = facts.find((f) => f.key === contribution.factKey);
      if (!fact) {
        return {
          verdict: hold(
            change,
            `Cannot decide: no stored fact for "${contribution.factKey}" (required by ${constraint.id}); ingest or enter this field first.`,
          ),
          checksRun,
          factsUsed,
        };
      }
      factsUsed.push(fact);

      const result = evaluateCheck(change, { constraint, contribution, fact });
      if (result) return { verdict: result, checksRun, factsUsed };
    }
  }

  if (checksRun.length === 0) {
    return {
      verdict: hold(
        change,
        "Cannot decide: no constraint consumes any fact this change touches; add the relevant constraint or fact keys first.",
      ),
      checksRun,
      factsUsed,
    };
  }

  return {
    verdict: {
      change,
      decision: "APPROVE",
      reason: `Approved: the change satisfies every affected constraint (${[...new Set(checksRun)].join(", ")}) with all deciding facts trusted.`,
    },
    checksRun,
    factsUsed,
  };
}

function round(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}
