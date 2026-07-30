# Tasks: score-layout-quality

## 1. Read-only board reader

- [x] 1.1 Implement `src/kicad/pcb.ts` on `parseSexp`: footprints (ref, value, lib id, layer, position, rotation), pads (number, net, absolute position after the footprint rotation, size, extent, expanded copper layers)
- [x] 1.2 Read courtyard extents from `F.CrtYd`/`B.CrtYd` graphics inside each footprint, and the Edge.Cuts outline extents from `gr_line`/`gr_rect`/`gr_arc`/`gr_circle`/`gr_poly` (including edge cuts carried inside a footprint)
- [x] 1.3 Read track segments and arcs, vias, and zones with their filled-polygon area
- [x] 1.4 Resolve both net encodings: `(net 3 "GND")`, bare `(net 3)` through the board net table, and `(net "GND")`; `net_name` wins for zones
- [x] 1.5 Calibrate the footprint rotation sense against real boards rather than from memory, and record the measurement in the module comment
- [x] 1.6 Verify against `/usr/share/kicad/demos/pic_programmer/pic_programmer.kicad_pcb` (KiCad 10) and `test/fixtures/open-key/hardware/open-key.kicad_pcb` (KiCad 8 empty scaffold); never serialize

## 2. Metrics

- [x] 2.1 Union-find connectivity over quantized points: segments union their endpoints per layer, vias union across layers, pads snap within `max(padExtent/2, 0.05 mm)`, a zone unions every pad on its net
- [x] 2.2 Soft scorecard: routed-net fraction, count and names of the unrouted nets, total track length, segment/via/zone counts, courtyard overlaps, off-board footprints, board area, placement density, copper area
- [x] 2.3 Hard table matched by constraint-key suffix (`*trace_width_mm`, `*board_outline_mm`, `*keepout`, `*mounting_hole_clearance_mm`, `*decoupling_distance_mm`, `*copper_area_mm2`); every row names its key, bound, measured value and `pass`/`fail`/`n/a`; an empty registry yields an empty table
- [x] 2.4 Roll into a 0-100 score with routed-net fraction as the dominant 40-point term, placement terms zeroed rather than awarded on an empty board

## 3. Tool and report

- [x] 3.1 Add the `layout_metrics` tool: no edit unlock, "does not apply yet" when no board is configured, in the voice of `run_drc`
- [x] 3.2 Point the stage-5 prompt at it: run after placing and after routing, fix what it flags
- [x] 3.3 `src/kicad/layout-report.ts`: `renderDraftQuality` (score breakdown, hard table with keys and statuses, soft scorecard) and `formatLayoutMetrics` for the agent
- [x] 3.4 In-place section upsert that regenerates the computed block and preserves prose below the notes marker, including a first pass over a section that predates the marker
- [x] 3.5 Wire it into `src/commands/create.ts` after the `layout-draft` completion contract is met, and on every later resume past that stage

## 4. Validation

- [x] 4.1 Commit the reference board fixture `test/fixtures/layout/reference-board.kicad_pcb` (8 footprints, 4 nets, a pour, two mounting holes, a via, one hard row per matcher)
- [x] 4.2 Mutation suite: caps moved 15 mm, power net narrowed to 0.25 mm, placement shuffled, ground zone deleted; each strictly lowers the score and each asserts which metric moved
- [x] 4.3 Corpus test over `/usr/share/kicad/demos`: every board scores without throwing, and the routed `multichannel_mixer` outscores its unrouted twin; skips when the directory is absent
- [x] 4.4 `scripts/layout-corpus-baseline.ts` plus `npm run layout:corpus`, writing the committed baseline distribution to `test/fixtures/layout-corpus-baseline.json`
- [x] 4.5 Unit tests: both net encodings, the empty scaffold, named unrouted nets, empty board never outscores a routed one, hard rows trace to their key, empty registry yields no rows, the tool without a board, the upsert preserving prose
- [x] 4.6 `npm run typecheck`, `npm run build`, `npm test`, `npm run lint:md` all pass

## 5. Deferred (documented, not implemented)

- [ ] 5.1 `sync_pcb_from_sch` netlist and footprint import: blocked on the `pcbnew` Python bindings, which are a KiCad install artifact and absent in CI; `kicad-cli` 10.0.4 has no netlist-into-board import
- [ ] 5.2 Declarative `placement.yaml` constraint solver: blocked on 5.1, because there is nothing to place until the footprints are imported
- [ ] 5.3 Freerouting / Specctra round-trip routing: blocked on a JVM, which is not a Copperhead dependency
- [ ] 5.4 Per-stage checkpointing of place / route-power / route-signal: belongs with the checkpoint work in the run-metrics change, not here
- [ ] 5.5 Corpus percentile recorded per run in `REPORT.md`: the baseline file exists for it; the reporting hook belongs with the run-report work

## 6. Archive

- [ ] 6.1 On archive, merge `layout_metrics` into SPEC.md's tool table and the generated `## Draft quality` section into the create-pipeline stage-5 description (via /opsx:archive)
