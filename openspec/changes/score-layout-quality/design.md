# score-layout-quality: Design

## Context

The layout stage is the only stage whose gate cannot distinguish "done" from "not started". `run_drc` reports legality, and the empty 30x20 mm scaffold is legal. Everything below exists to give that stage a measure it cannot be talked out of.

Inherited constraints from SPEC.md that shape every decision:

- KiCad files are edited by anchored exact-match text replace only; the s-expression layer never serializes (§1.3, design D4). Any new KiCad reading is therefore read-only, and nothing here writes board geometry.
- `check` stays LLM-free and network-free. Nothing here is reachable from `check` anyway, but the same discipline applies: the scorer makes no subprocess call and no network call.
- Tool gating is structural. `layout_metrics` reads and reports, so it sits in the unlocked tier next to `run_erc` and `run_drc`.

## Goals / Non-Goals

**Goals**

- "Is this layout good?" has a deterministic, constraint-traceable answer.
- The answer is calibrated against real boards, not asserted.
- An empty board can never score like a finished one.
- The `## Draft quality` label is computed rather than promised.

**Non-Goals**

- Automatic placement or routing. Deferred with reasons in the proposal.
- Reimplementing DRC. KiCad's own engine stays the authority on legality; this measures quality.
- Exact netlist extraction. The connectivity model is an approximation on purpose (D2).
- Any new runtime dependency.

## Decisions

### D9 — Layout metrics read the board and nothing else

`computeLayoutMetrics(board, constraints)` is a pure function of a parsed `.kicad_pcb` plus the constraint registry. Deliberately *not* consulting the agent, the schematic, or `kicad-cli`: the refusal in run `2026-07-29T19-54-42-021Z` reported board state that contradicted tool output in the same turn, so the scorer must not be able to be told anything. Purity also keeps the scorer usable on any board file, which is what makes the demo corpus a valid calibration set: a scorer that needed a Copperhead repo around it could not be pointed at `/usr/share/kicad/demos` at all.

Net identity spans two file generations. KiCad 8/9 writes `(net 3 "GND")` on pads, bare `(net 3)` on segments and zones, and a top-level `(net 3 "GND")` table; KiCad 10 writes `(net "GND")` everywhere. `src/kicad/pcb.ts` resolves all three forms to a name, so the same code reads the 2024 fixture and the 2026 demo.

Pad positions are absolute, which means applying the footprint rotation. KiCad's `RotatePoint` sense is `x' = x·cos + y·sin`, `y' = -x·sin + y·cos` (the board Y axis grows downward). That was picked by measurement, not by reading: under the alternative sense, measurably fewer pads land on real track endpoints on every demo board checked (`pic_programmer` 139 vs 120, `multichannel_mixer` 328 vs 287, `video` 1297 vs 1256).

**Connectivity model.** A net is *routed* when all its pads land in one connected component. Components are built by union-find over points quantized to 1 µm: each track segment unions its endpoints on its own layer, a via unions coincident points across the layers it spans, a pad unions with any track endpoint within `max(padExtent / 2, 0.05 mm)`, and a zone on a net unions every pad on that net. This is deliberately an approximation, and it over-credits rather than under-credits (a pour is assumed to reach the pads on its net), so the metric never flags a good board on connectivity it cannot see. It is calibrated by the corpus test rather than asserted to be exact.

**Hard vs soft.** Hard rows exist only when a matching key exists in `.copperhead/constraints.json`, matched by key *suffix* so that a project's own namespacing (`mech.load_trace_width_mm`, `pwr.trace_width_mm`) lands on the same measurement. A board with no constraints gets an empty hard table and a soft-only score, and every hard row names the constraint key it came from, which is what makes "every hard metric traces to a key" checkable rather than aspirational. A row whose measurement the board cannot answer (no mounting holes, no bypass caps, no tracks on a power net) is `n/a` with a note, never a silent pass: an `n/a` row is excluded from the score's hard term rather than counted as a success.

**The 0-100 score.** Six terms: routed nets 40, hard constraints 20, courtyard clearance 12, on-board placement 12, placement density 8, routing directness 8. Routed-net fraction dominates because that is the axis on which the routed and unrouted `multichannel_mixer` differ, and because an empty board must not tie a finished one. The placement terms are **zeroed, not awarded**, when there are no footprints: an empty board must not bank points for the courtyard overlaps it does not have. That is what puts the empty scaffold (20, hard-vacuous only) below a placed-but-unrouted board (about 50) below a routed one (about 93). Routing directness is the weighted mean of per-net `MST / actual track length`, over routed nets that carry track copper and have no pour on them; a pour-connected net's track length says nothing about its routing quality, and per-net clamping stops one 2000-pad ground net from setting the whole board's ratio.

### D10 — Validation is a mutation suite first, a corpus second

The mutation suite runs on committed fixtures in `test/fixtures/layout/`, so it runs everywhere including CI: take a good board, degrade it four ways (decoupling caps moved 15 mm, power net narrowed to 0.25 mm, placement shuffled, ground zone deleted), require the score to fall each time. Each mutation also asserts *which* metric moved, so a mutation that lowers the score for the wrong reason fails. That is the regression test that catches a scorer or (later) a placer change that quietly makes layouts worse.

Mutations are anchored exact-match text replaces on the fixture source, the same discipline the product itself uses on KiCad files. Nothing in the suite serializes a board, and the suite asserts the fixture on disk is unchanged when it finishes.

The `/usr/share/kicad/demos` corpus is a second, machine-dependent tier: the test skips when the directory is absent rather than failing, because the demos are a KiCad install artifact and not a Copperhead dependency. When present it asserts the labeled pair (routed > unrouted) and that all boards score without throwing. `npm run layout:corpus` writes the baseline distribution to `test/fixtures/layout-corpus-baseline.json`, committed and timestamp-free so that a scorer change shows up as a reviewable diff rather than as nothing at all.

One demo board (`royalblue54L_feather/RoyalBlue54L-Feather.kicad_pcb`) is written with a stray close-paren that ends the outer `(kicad_pcb …)` form early and spills two thirds of the board out as sibling top-level forms. Reporting the 2 footprints that landed before the break, rather than the 71 that are there, is a worse failure than throwing. The reader adopts stray top-level forms as board children; it is read-only, so being generous costs nothing.

### D11 — `## Draft quality` is generated, then annotated

`renderDraftQuality(metrics)` produces the section body: the score with its term breakdown, the hard table with pass/fail and the constraint key per row, and the soft scorecard. `upsertDraftQuality` replaces that block in place and keeps everything below a notes marker, so the computed part is regenerated and the judgement part is preserved. A section that predates the marker (the model wrote it by hand) has its whole body treated as notes on the first regeneration, so nothing the model wrote is ever destroyed.

The create pipeline regenerates it after the `layout-draft` stage's completion contract is met, and again on every later resume past that stage, so the section tracks the board rather than the moment it was written. Best-effort: a failure is logged and never fails the pipeline, because the design is already committed by then.

## Risks / Trade-offs

- **The connectivity model is approximate.** A zone unions all pads on its net, which credits a pour that may not actually reach a pad. It over-credits rather than under-credits, so the metric is conservative in the direction of not flagging good boards; the mutation that deletes the zone is what keeps it honest.
- **The score's weights are a judgement call.** 40/20/12/12/8/8 is defensible but not derived. The corpus baseline is the guard: the committed distribution makes a reweighting a visible, reviewable diff across 19 real boards rather than a silent change.
- **Hard rows depend on constraint hygiene.** A project that never records `mech.load_trace_width_mm` gets no width row and a full 20-point hard term. That is the correct behaviour (inventing a bound would be worse than having none), but it means the hard half of the score is only as good as the registry, and the `## Draft quality` section says so in the empty case.
- **Two demo boards are ~70 MB.** Parsing them peaks around 1 GB of heap and the full corpus sweep takes about 19 s. It is guarded by an explicit per-test timeout and it is skipped wherever the demos are absent, so it never lands on CI.
- **Regenerating `## Draft quality` leaves the file dirty.** The write happens after the stage's own commit, so the refreshed section rides along in the next stage's commit. A rollback that discards it is self-healing: the next resume past the layout stage regenerates it from the board.

## Migration Plan

Purely additive. No existing output changes shape, no existing tool changes behaviour, and a repo with no layout constraints recorded sees an empty hard table rather than new failures. Rollback is deleting the three new modules, the tool entry, and the two create call sites. On archive, SPEC.md's tool table and the stage-5 description gain `layout_metrics` and the generated section.

## Open Questions

- Whether the per-run score should be recorded into `.copperhead/runs/REPORT.md` as a corpus percentile alongside cost. The baseline file exists for exactly that and the reporting hook is a small follow-up, but it belongs with the run-report work rather than here.
- Whether the placement-intent spec, when the placer lands, should live in `openspec/changes/<id>/` (reviewable like every other change artifact) or in `.copperhead/`. Not settled, and not settled by this change.
