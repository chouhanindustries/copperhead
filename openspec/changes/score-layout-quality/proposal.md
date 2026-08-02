# score-layout-quality: Proposal

## Why

Stage 5 (`layout-draft`) has exactly one check: `run_drc`. DRC is a legality test, and a weak signal in both directions. The current 30x20 mm empty scaffold passes DRC trivially, so **a board with nothing on it scores identically to a finished one**. Meanwhile a DRC-clean board can still have a bypass cap 20 mm from the pin it decouples, a 2 A return path with no copper behind it, and a sensor staring into the load connector: every one of those is named by a key already sitting in `.copperhead/constraints.json`, and none of them is a DRC rule.

So the pipeline's acceptance criterion for layout is "the model says it's fine", which is exactly what the stage prompt's "unlabeled non-optimal is not acceptable" clause is trying and failing to compensate for. Worse, the model's account of the board is not reliable: run `2026-07-29T19-54-42-021Z` refused the layout stage claiming 14 unconnected items in a turn where `run_erc` had returned "ERC: clean".

Measurement has to land before generation. A deterministic placer and router (issue #141's other half) is only worth building once there is a way to tell whether its output is better than what came before, and once that measure has been calibrated against real boards rather than asserted.

## What Changes

- **`src/kicad/pcb.ts`**: a read-only `.kicad_pcb` reader alongside the existing schematic reader. Footprints (reference, position, rotation, layer), pads (number, net, absolute position after the footprint rotation, extent, copper layers), courtyard extents from `F.CrtYd`/`B.CrtYd`, track segments, vias, zones with their filled area, and the Edge.Cuts outline extents. Resolves both net encodings: the KiCad 8/9 numeric form through the board net table, and the KiCad 10 named form. Never serializes.
- **`src/kicad/layout-metrics.ts`**: `computeLayoutMetrics(board, constraints)`, a pure function of the parsed board plus the constraint registry.
  - A **hard table** whose rows exist only when a matching `.copperhead/constraints.json` key exists, matched by key suffix (`*trace_width_mm`, `*board_outline_mm`, `*keepout`, `*mounting_hole_clearance_mm`, `*decoupling_distance_mm`, `*copper_area_mm2`). Every row names its key, the expected bound, the measured value, and `pass` / `fail` / `n/a`.
  - A **soft scorecard**: routed-net fraction and the names of the unrouted nets, total track length, segment and via counts, courtyard overlap count, off-board footprint count, board area, placement density, copper area. Rolled into a 0-100 score whose dominant term (40 points) is routed-net fraction.
- **`layout_metrics` tool**: exposes the scorecard to the agent, needs no edit unlock, and reports that the check does not apply yet when no board is configured. The stage-5 prompt now tells the model to run it after placing and after routing.
- **`src/kicad/layout-report.ts` + create wiring**: `docs/LAYOUT.md`'s `## Draft quality` section is generated from the scorecard and regenerated in place once the layout stage's completion contract is met, preserving the model's prose below a notes marker.
- **Validation**: a committed reference board under `test/fixtures/layout/`, a four-way mutation suite that runs in CI and requires the score to fall for each degradation, a corpus test over `/usr/share/kicad/demos` that skips when the demos are absent, and `npm run layout:corpus` writing a committed baseline distribution.

### Explicitly deferred

The generation half of issue #141 is **not** in this change, and the reason is dependency-shaped rather than effort-shaped:

- **`sync_pcb_from_sch` (netlist and footprint import)**: KiCad 10.0.4's `kicad-cli` has no netlist-into-board import, so this needs the `pcbnew` Python bindings. Those are a KiCad install artifact, not a Copperhead dependency, and are not present in CI.
- **The declarative `placement.yaml` constraint solver**: blocked behind the import above, because placing footprints that are not on the board yet is not a solvable problem.
- **Freerouting / Specctra routing**: needs a JVM. Same argument.

Scoring lands first because it is how the placer will be judged: without it, a placer change that quietly makes layouts worse looks exactly like a DRC-clean board nobody looks at.

## Capabilities

### New Capabilities

- `layout-quality`: the read-only board reader, the hard-constraint table and soft scorecard, the `layout_metrics` tool, the generated `## Draft quality` section, and the mutation-and-corpus validation protocol that calibrates the scorer.

## Impact

- **Code**: new `src/kicad/pcb.ts`, `src/kicad/layout-metrics.ts`, `src/kicad/layout-report.ts`; `src/agent/tools.ts` gains `layout_metrics`; `src/commands/create.ts` regenerates the `## Draft quality` block and its stage-5 prompt points at the new tool; new `scripts/layout-corpus-baseline.ts` and the `layout:corpus` npm script.
- **Fixtures**: `test/fixtures/layout/reference-board.kicad_pcb` (the mutation subject) and `test/fixtures/layout-corpus-baseline.json` (the recorded distribution).
- **Tests**: `test/layout-pcb.test.ts`, `test/layout-metrics.test.ts`, `test/layout-mutation.test.ts`, `test/layout-tool.test.ts`, `test/layout-corpus.test.ts`.
- **Dependencies**: none new. Node, the existing s-expression reader, and nothing else. No `kicad-cli` call, no network, no LLM.
- **Unchanged contracts**: the s-expression layer stays read-only; no board is ever serialized; `edit_file`/`write_file` gating is untouched; `check` gains nothing and stays LLM-free.
- **Specs**: on archive, SPEC.md's tool table and the create-pipeline stage-5 description gain `layout_metrics` and the generated `## Draft quality` section.
