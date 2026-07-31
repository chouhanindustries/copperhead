# readable-schematic-drafting: Proposal

## Why

Stage 4 of `copperhead create` verifies only electrical facts: ERC checks the net graph as drawn, `verify_symbols` checks lib_id and pin fidelity. Nothing verifies how the drawing *reads*, so legibility is the one stage-4 output with no gate on it, and it drifts run to run. A recent run produced a sheet with refdes and value text sitting on top of symbol bodies and wires (four labels inside one 10mm box), net labels rotated 90 degrees where a horizontal label would fit, all content packed into roughly 40% of an A4 sheet with the right 40% and bottom 35% empty, no left-to-right signal flow, power and ground flags at ragged inconsistent heights, and an empty title block. The stage-4 prompt says nothing about drafting conventions: it covers the 1.27mm grid and the labels-are-not-wires rule, and stops there.

An unreadable schematic is not a cosmetic problem for this product. The schematic is the primary human review surface for everything the agent claims to have designed, and "reviewable as a whole" is the stated end-product guarantee of the create pipeline (SPEC.md §3). A sheet a hardware engineer will not read is a design they cannot check.

## What Changes

- **A drafting standard for generated schematics**, derived from how competent human-authored KiCad sheets are organized:
  - **Subsystem group boxes**: every non-power symbol belongs to exactly one functional group (power ports and `PWR_FLAG` are exempt), and every group is drawn as a schematic `(rectangle …)` outline with a `(text …)` caption naming it (for example "LiPo Charger", "16MB Flash - W25Q128"). Solid outlines for functional blocks, dashed for annotation groups such as a decoupling bank or a boot/reset cluster.
  - **Block-partitioned layout**: groups tile the sheet in columns with no overlap, one subsystem per block, taken from SUBSYSTEMS.md. A large MCU or connector gets its own full-height column.
  - **Label-driven inter-block connectivity**: wires stay short and local inside a block; connections between blocks are made with net labels, not long wires crossing the sheet.
  - **Page sized to content**: the paper size is chosen so groups fill the frame instead of crowding one corner of an oversized sheet or spilling off a small one.
  - **Title block filled**: title, revision, and date are populated, never left blank.
- **New deterministic checker `src/kicad/legibility.ts`**, read-only, built on the existing `src/kicad/sexp.ts` parser and never serializing (SPEC §1.3, phase-1 design D4). It reports one finding per defect with coordinates and an actionable fix, over these check families: symbol-body overlap; text collision (refdes, value, or label text over a symbol body, a wire, or other text); off-grid symbol origins, wire endpoints, and label positions; label orientation rotated where horizontal fits; content bounding box versus page size (utilization too low, or content outside the drawing frame); nearest-neighbour crowding below a readable pitch; ungrouped symbols and missing or unlabeled group boxes; overlapping group boxes; wires crossing a symbol body without terminating on a pin; empty title-block fields.
- **New agent tool `check_legibility`**, shaped exactly like `verify_symbols`: returns "no findings" or a numbered list of divergences to reconcile.
- **Stage-4 prompt gains a drafting-conventions block** stating the standard above, plus the instruction to run `check_legibility` and reconcile every finding before finishing, the same obligation that already exists for `verify_symbols`.
- **Stage-4 completion contract gains legibility**: the schematic stage does not complete while error-severity legibility findings remain unreconciled.
- **`check` reports legibility advisories**: the checker is fully deterministic and network-free, so it belongs in `check`, but its findings are advisory and do not affect the exit code. Existing CI and pre-commit users gain information, not a new failure class. `--json` gains a `legibility` key.

## Capabilities

### New Capabilities

- `schematic-legibility`: the drafting standard (group boxes, block partitioning, label-driven inter-block nets, page sizing, title block), the check families and their severities, threshold and configuration semantics, finding format, and reconcile semantics.

### Modified Capabilities

- `create-pipeline`: the schematic stage gains drafting conventions in its prompt and a legibility condition in its completion contract.
- `agent-core`: the tool list gains `check_legibility`, available in the same phase as `verify_symbols`.
- `cli-surface`: `check` reports legibility advisories without affecting the exit code; `--json` gains a `legibility` key.

## Impact

- **Code**: new `src/kicad/legibility.ts` (group and bounding-box extraction, stroke-font text extent approximation, the check families, finding normalization); new `check_legibility` tool in `src/agent/tools.ts`; stage-4 prompt and completion contract in `src/commands/create.ts`; `check` wiring in `src/commands/check.ts`.
- **Config**: `.copperhead/config.json` gains an optional `legibility` block (thresholds, per-check severity overrides, with `off` disabling a family).
- **Fixtures**: a well-drafted schematic fixture that passes clean, plus a deliberately ugly variant exercising each check family.
- **Spec**: acceptance criteria added to SPEC.md in the AC-15.x family alongside the existing content-aware stage-completion criteria.
- **Unchanged contracts**: `check` stays LLM-free and network-free; the sexp parser still never serializes; no existing repo starts failing because of this change.
- **Archive ordering**: the create-pipeline delta modifies the "Content-aware stage completion" requirement, whose base text currently exists only in the active `turn-budget-continue-and-loop-efficiency` change. That change must archive first, so the base requirement is present in the main spec when this delta merges. The agent-core delta's legibility obligation should likewise be shaped together with the `symbol-verification` obligation kind proposed in #133 rather than landing as two inconsistent ledger entries.
