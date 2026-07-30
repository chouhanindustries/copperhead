# Tasks: readable-schematic-drafting

## 1. Geometry primitives

- [ ] 1.1 Extend `src/kicad/sexp.ts` with the read-only accessors the checker needs: sheet graphic items (`rectangle`, `text`, `polyline`, `circle`, `arc`), wire segments with endpoints, label items with position and rotation, `(paper …)`, and `(title_block …)` fields
- [ ] 1.2 Implement symbol body bounding boxes in `src/kicad/legibility.ts`: union the `lib_symbols` graphic items of the instance's library entry, exclude pin name/number text, transform by `at`/rotation/mirror reusing the existing pin transform
- [ ] 1.3 Implement conservative stroke-font text extents (advance ratio below true average, per D4) for property text, labels, and free text; unit tests pinning the ratio and the resulting boxes
- [ ] 1.4 Implement the standard paper-size table, frame border, and reserved title-block rectangle; usable-area computation; unknown-size returns skipped rather than passing

## 2. Check families

- [ ] 2.1 Group model: extract group rectangles and captions, resolve symbol membership by geometric containment (innermost wins), exempt power-port symbols; families `ungrouped-symbol`, `unlabeled-group`, `group-overlap`
- [ ] 2.2 Caption validation against subsystem names in SUBSYSTEMS.md and component groups in BOM.md
- [ ] 2.3 Collision families: `symbol-overlap`, `text-collision`, `wire-through-symbol` (wire crossing a body without terminating on that symbol's pin)
- [ ] 2.4 Grid and frame families: `off-grid` (symbol origins, wire endpoints, label positions) reported first per D10; `out-of-frame`
- [ ] 2.5 Advisory families: `low-utilization`, `crowding`, `label-orientation` (rotated where a horizontal draw would collide with nothing), `cross-group-wire`
- [ ] 2.6 `empty-title-block` over title, revision, and date
- [ ] 2.7 Finding shape `{kind, severity, sheet, at, refs, detail}` with the concrete fix in `detail`; unordered-pair dedup; per-family per-sheet cap with an explicit suppressed count
- [ ] 2.8 Walk the full sheet hierarchy from the root schematic; attribute every finding to its sheet; page checks use each sheet's own paper value

## 3. Configuration

- [ ] 3.1 Add the optional `legibility` block to `.copperhead/config.json` (per-family severity including `off`, thresholds for grid pitch, minimum pitch, utilization fraction, maximum wire length, per-family cap) with documented defaults applied when absent
- [ ] 3.2 Document the block in the generated `.copperhead/README.md`

## 4. Agent and pipeline wiring

- [ ] 4.1 Add the `check_legibility` tool to `src/agent/tools.ts`, shaped like `verify_symbols`: numbered findings with kind, severity, sheet, coordinates, refdes, and fix; graceful message when no schematic is configured
- [ ] 4.2 Feed outstanding error-severity findings into the sync-obligations ledger so `finish` refuses while the sheet is illegible
- [ ] 4.3 Add the drafting-conventions block to the stage-4 instruction in `src/commands/create.ts` (group boxes per subsystem, non-overlapping tiled blocks, full-height column for a large MCU or connector, left-to-right flow within a group, rails up and grounds down, pitch that clears neighbour refdes/value text, labels rather than long wires between groups, spares in their own annotation group, paper sized to fill the frame, populated title block)
- [ ] 4.4 Add the reconcile instruction to stage 4: run the legibility check after placement and resolve every error-severity finding before finishing
- [ ] 4.5 Extend the schematic stage completion contract with zero error-severity findings; unmet contract halts with finding counts by kind and a resume hint; advisories recorded in the run summary

## 5. `check` integration

- [ ] 5.1 Run the checker in `src/commands/check.ts`, printing findings grouped by severity under a legibility heading, with the exit code unaffected at every severity
- [ ] 5.2 Add the `legibility` key to `check --json` (findings, per-severity counts, skipped and disabled families), present with an empty list when clean

## 6. Fixtures and tests

- [ ] 6.1 Add a well-drafted fixture schematic (captioned group boxes, tiled blocks, labels between groups, filled title block) that reports zero findings
- [ ] 6.2 Add an illegible variant exercising every family, plus a hierarchical fixture with a defect only on a sub-sheet
- [ ] 6.3 Tests: per-family detection, conservative-extent behavior (marginal case is not reported), pair dedup, cap with stated suppressed count, severity override and `off`, unknown paper skip, power-symbol group exemption
- [ ] 6.4 Tests: checker leaves file bytes unchanged, makes no subprocess or network call, and `check` exit code is unaffected by findings
- [ ] 6.5 Tests: stage-4 completion contract fails on error findings and passes with advisories only; `finish` lists outstanding findings as unmet obligations

## 7. Docs and spec

- [ ] 7.1 README: schematic drafting standard and the legibility gate (what gates, what advises, how to configure)
- [ ] 7.2 Add the AC-15.x acceptance criteria for the drafting standard and the stage gate to SPEC.md on archive (via /opsx:archive)
