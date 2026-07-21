# add-spice-verification-gate: Proposal

## Why

ERC and DRC gate connectivity and layout, but a schematic can be electrically connected and still behaviorally wrong: a divider that starves an ADC, an RC filter with the wrong corner, a reference that sags under load. Extending "nothing is done until the tools agree" from connectivity to behavior is the natural next verification gate (roadmap Phase 2, item 4), and SPEC.md §8 already names ngspice as the intended simulation checker; the verify architecture is checker-agnostic by design.

## What Changes

- **New verification gate: SPICE simulation via ngspice**, opt-in per subsystem:
  - A subsystem is flagged simulatable by a `## Simulation` block in SUBSYSTEMS.md naming the netlist scope (sheet or net set), the analysis (`op`, `dc`, `ac`, `tran`), and one or more assertions (`V(out) between 3.25 and 3.35`, `I(R5) < 25uA`).
  - The gate exports the scoped netlist via `kicad-cli sch export netlist --format spice`, runs ngspice in batch mode, evaluates the assertions, and normalizes results into the same violation shape ERC/DRC use.
- **Loop integration**: when a run touches a flagged subsystem, the SPICE gate joins ERC (and DRC when the board changed) in the verify step, with the same repair-up-to-`maxRepairCycles`-then-rollback discipline.
- **`check` integration**: `check` runs the SPICE gate for flagged subsystems when ngspice is installed; when it is missing, `check` reports the gate as skipped with an install hint (never a silent pass), and `--strict` turns skipped-with-flags into a failure.
- Assertions become first-class constraint sources: a `## Simulation` assertion derived from a budget MUST reference the budget, wiring simulation into the existing constraint registry via the normal dual-write obligation.
- Deterministic and network-free: ngspice is a local subprocess, same trust model as `kicad-cli`.

## Capabilities

### New Capabilities

- `spice-verification`: the `## Simulation` block format, netlist export scope, ngspice invocation and result normalization, assertion grammar, and skip/strict semantics.

### Modified Capabilities

- `agent-core`: the verify step of the loop gains the SPICE gate for flagged subsystems, under the existing repair/rollback rules.
- `cli-surface`: `check` runs (or reports skipping) the SPICE gate; `--json` gains a `spice` key.

## Impact

- **Code**: new `src/kicad/spice.ts` (netlist export scoping, ngspice wrapper, assertion evaluator, result normalizer, ngspice version detection mirroring the kicad-cli wrapper); loop verify-step wiring; `check` wiring.
- **Config**: `.copperhead/config.json` gains `spice` (enable flag, ngspice path override, per-analysis timeout).
- **Fixtures**: a small analog subcircuit (divider + RC) with a `## Simulation` block, plus a deliberately failing variant.
- **Dependencies**: ngspice as an optional system dependency, detected like `kicad-cli`; nothing bundled.
- **Unchanged contracts**: `check` stays LLM-free and network-free; repos with no `## Simulation` blocks see zero behavior change.
