# readable-schematic-drafting: Design

## Context

The create pipeline's schematic stage hands the model a scaffolded empty `.kicad_sch` and asks it to populate the file with anchored edits. Every gate on that stage is electrical: `run_erc` checks the net graph as drawn, `verify_symbols` (`src/kicad/symlib.ts`) checks that each `lib_symbols` entry matches the installed KiCad library. Geometry is unconstrained apart from one sentence about the 1.27mm grid, so placement is whatever the model chose token by token, and the result is a sheet that is electrically correct and visually unreadable.

`symlib.ts` is the precedent this change copies. It exists because ERC checks the graph but not the parts, so a wrong pin set passed every gate while being wrong. The same argument applies one level up: ERC checks the graph but not the drawing, so an unreadable sheet passes every gate while being unreviewable. `symlib.ts` solved it with a read-only checker module, an agent tool that reports divergences, and a prompt obligation to reconcile them. This change adds the same three pieces for legibility, plus a stage-completion condition.

The target style is a block-partitioned sheet: each subsystem drawn inside a captioned box, boxes tiled to fill the frame, short wires inside boxes and net labels between them, a large MCU given its own full-height column, and a filled title block. This is how competent human-authored KiCad sheets are organized, and it is the reference the user supplied.

## Goals / Non-Goals

**Goals:**

- A generated schematic a hardware engineer will actually read: grouped, captioned, non-overlapping, frame-filling.
- Legibility verified deterministically, so it cannot regress the way a prompt-only fix would.
- Findings that name a defect, a location, and a concrete fix, so the repair loop converges instead of guessing.
- Zero new failures for existing repos: the gate binds where copperhead authored the sheet, not where a user merely runs `check`.

**Non-Goals:**

- No automatic placement engine. This change does not compute coordinates or write geometry; that is a much larger change and is deliberately kept as a possible successor.
- No aesthetic scoring or "beauty" metric. Every check is a mechanical predicate with a coordinate answer.
- No board-layout equivalent in this change. The same argument applies to `.kicad_pcb`, but DRC already covers the load-bearing part of it.
- No re-drafting of hand-authored user schematics. `check` reports; it never rewrites.

## Decisions

- **D1: Checker, not auto-placer.** The repo invariant is that the s-expression parser never serializes and KiCad files change only through anchored exact-match text replaces (SPEC §1.3, phase-1 design D4). An auto-placer would have to emit geometry from code, breaking that invariant, and it would also have to solve the placement problem well enough to beat the model on every topology. A checker keeps authorship with the agent and adds the missing feedback signal. Alternative considered: a deterministic placer that computes coordinates from the netlist. Rejected for this change, kept as a successor once the checker has pinned down what "good" means in machine-checkable terms.

- **D2: Groups are plain rectangles and text, not KiCad `(group …)` items.** KiCad's native group construct is an editor selection aid: a uuid membership list that draws nothing on a plot. The goal here is a visible captioned box in the SVG and PDF exports, which means a schematic `(rectangle …)` graphic plus a `(text …)` caption. That is also far easier for the agent to author through anchored edits and for the checker to read back geometrically. Membership is therefore geometric containment, not a stored list, which has the useful property that a symbol dragged out of its box is immediately detectable.

- **D3: Symbol body bounding boxes come from `lib_symbols` graphics only.** For each instantiated symbol, the checker unions the `rectangle`, `polyline`, `circle`, and `arc` items of its library entry, then transforms by the instance's `at` position, rotation, and mirror, reusing the transform already implemented for pins in `src/kicad/sexp.ts`. Pin name and pin number text are excluded from the body box: they sit inside large IC outlines by design, and including them would make every dense MCU symbol self-colliding.

- **D4: Text extents are approximated conservatively, and deliberately under-estimate.** KiCad renders with a stroke font that has no metrics table we can read without depending on KiCad internals. The checker approximates a text item's box as `chars × advance × height` wide by `height` tall, with the advance ratio fixed at 0.6 (a dimensionless fraction of the font height per character), below the stroke font's average advance. Under-estimating means the checker misses marginal collisions rather than inventing them. That asymmetry is the right one: a false positive costs repair turns and can make the stage contract unsatisfiable, while a false negative leaves one slightly tight label on an otherwise organized sheet.

- **D5: The gating set is exactly the defects with a deterministic local fix.** `symbol-overlap`, `text-collision`, `off-grid`, `out-of-frame`, `ungrouped-symbol`, `unlabeled-group`, `group-overlap`, `wire-through-symbol`, and `empty-title-block` gate the stage: each has an unambiguous answer and a single move that resolves it. `low-utilization`, `crowding`, `label-orientation`, and `cross-group-wire` are advisory: each rests on a threshold or a judgment call, and gating on a threshold invites the repair loop to thrash against a number rather than fix a defect. The advisory families still reach the model, and the drafting conventions in the prompt aim to satisfy them on the first pass rather than through repair.

- **D6: Findings are deduplicated by unordered pair and capped per family per sheet, with the suppressed count stated.** A crowded cluster of n symbols otherwise emits O(n²) findings and drowns the report. The cap is per family per sheet with an explicit "N more suppressed" line, never a silent truncation.

- **D7: `check` reports, `create` gates.** The checker is deterministic and network-free, so it satisfies `check`'s contract and belongs in its output. But `check` is documented as CI and pre-commit safe, and existing repos contain hand-drawn schematics that would light up under these checks. Making it fail would break users on upgrade for a defect class they never opted into. So `check` prints findings and leaves the exit code alone; the binding gate lives in the create pipeline's schematic stage, where copperhead itself authored the sheet and is responsible for it.

- **D8: Thresholds and per-family severity live in an optional config block with documented defaults.** `legibility.severity.<kind>` accepts `error`, `advisory`, or `off`, and `legibility.thresholds.*` covers grid pitch, minimum readable symbol pitch, utilization fraction, maximum wire length, and the per-family cap. Absent config means these defaults: grid pitch 1.27mm, minimum readable symbol pitch 2.54mm edge to edge between symbol body boxes, utilization fraction 0.5 of the usable frame area, maximum wire length 50.8mm, and a per-family cap of 10 findings per sheet. Geometric comparisons apply a 0.01mm tolerance so file-precision noise cannot flip a finding, and the measured utilization is compared before rounding and reported to two decimal places. These are starting values: the fixtures and tests pin them, and a real topology that disagrees tunes them through config rather than through code. The `off` escape hatch matters: if one family proves noisy on a real topology, a user can disable it without pinning an old version.

- **D9: Page geometry comes from a standard-size table plus a reserved title-block rectangle.** `(paper …)` resolves against a table of standard sizes; the usable area is the page minus the frame border and minus the reserved bottom-right title-block rectangle. An unrecognized paper value makes the page-relative checks report as skipped for that sheet rather than pass, matching the "loud skip, never silent" rule the SPICE gate already established.

- **D10: Off-grid findings are reported first.** A model repairing a collision by nudging a symbol can silently break connectivity, since an off-grid pin does not connect. Ordering the report so grid violations lead, and keeping ERC in the same loop, makes that failure mode visible in the same turn it is introduced.

## Risks / Trade-offs

- [False-positive collisions make the stage contract unsatisfiable and burn the turn budget] → conservative text extents (D4), body boxes that exclude pin text (D3), a gating set limited to unambiguous defects (D5), per-family `off` in config (D8), and the existing repair-cycle cap and rollback as the backstop.
- [The model resolves a collision by moving a symbol off-grid, breaking connectivity] → `off-grid` is itself a gating family, ERC runs in the same loop, and findings are ordered grid-first (D10).
- [Group boxes get drawn as decoration around nothing, satisfying the letter of the check] → membership is geometric and every non-power symbol must fall inside exactly one group; captions must be present and must name a subsystem from SUBSYSTEMS.md or a component group from BOM.md, so an empty or invented box is itself a finding.
- [Large IC symbols with dense internal pin text trip text-collision] → pin name and number text are excluded from both the body box and the text-collision family; only Reference, Value, and free text and label items participate.
- [More work per schematic stage, so more turns] → advisory families never gate, and the conventions are stated up front in the prompt so the common case is drafted right rather than repaired. If stage-4 turn cost rises materially in practice, the utilization and crowding families are the first candidates to move behind config.
- [A stricter gate could stall the pipeline on a repo where the checker is wrong] → the completion contract halts with a resume hint rather than discarding work, which is the behavior already specified for content-aware stage completion.

## Migration Plan

Additive. Existing repos see new advisory output from `check` and no exit-code change. New `create` runs get the drafting conventions and the gate. The delta specs merge into SPEC.md on archive, with acceptance criteria added to the AC-15.x family alongside the existing content-aware stage-completion criteria.

## Open Questions

- Whether the schematic scaffold should pre-draw empty captioned group boxes from SUBSYSTEMS.md before the model starts placing, turning "organize the sheet" into "fill the boxes". Likely a strong follow-up, but it is a scaffold change and belongs in its own change.
- Whether `label-orientation` can be tightened from advisory to gating once the "would horizontal fit" test is proven against real sheets.
