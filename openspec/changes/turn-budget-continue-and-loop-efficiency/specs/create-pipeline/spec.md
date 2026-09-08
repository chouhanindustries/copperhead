# create-pipeline delta spec

## ADDED Requirements

### Requirement: Per-stage turn budgets

`.copperhead/config.json` SHALL accept an optional `stageMaxTurns` object mapping create-pipeline stage names to turn budgets. When a stage runs and its name has an entry, that value SHALL be the run's `maxTurns`; stages without an entry use the global `maxTurns`. Unknown stage names in the map SHALL be ignored.

#### Scenario: Stage-specific budget applies (AC-15.18)

- **WHEN** config contains `"stageMaxTurns": {"spec-seed": 60}` and the spec-seed stage runs
- **THEN** that stage's run enforces a 60-turn budget while other stages keep the global `maxTurns`

#### Scenario: Absent map changes nothing (AC-15.19)

- **WHEN** config has no `stageMaxTurns`
- **THEN** every stage uses the global `maxTurns` exactly as before

### Requirement: Content-aware stage completion

Stage completion SHALL be judged by repo state and the applicable deterministic gate, not artifact existence alone: the schematic stage is complete only when the configured schematic contains at least one symbol AND the BOM/PINOUT tables are drift-clean against it; the layout-draft stage is complete only when a configured board exists containing at least one footprint, the LAYOUT.md draft-quality marker is present, AND KiCad DRC reports zero violations including zero unconnected items. The outputs stage is complete only when that board remains DRC-clean and all concrete `exportFab` outputs plus the ordering BOM are present, non-empty, and match a successful-export receipt that hashes the current board, schematic, BOM source, KiCad `.gbrjob` file list, and every output. After a stage's agent run finishes with outcome success, `create` SHALL re-check that stage's completion contract and halt the pipeline (preserving committed partial work, with a resume hint) if the contract is not met, instead of advancing to later stages.

#### Scenario: Blank sheet does not complete the schematic stage (AC-15.23)

- **WHEN** the schematic stage's run succeeds but the configured schematic contains zero symbols
- **THEN** `create` reports the stage contract as unmet, does not advance, and a re-run of `copperhead create` resumes at the schematic stage

#### Scenario: Pipeline halts on planning-only output (AC-15.24)

- **WHEN** any stage's agent run returns success without satisfying that stage's completion contract
- **THEN** `runCreate` returns not-ok with the completed-stage list so far, and later stages do not run

#### Scenario: Ratsnest cannot complete layout (AC-15.30)

- **WHEN** the configured board has footprints and a filled Draft quality section but KiCad DRC reports an unconnected item or any other violation
- **THEN** layout-draft remains incomplete on both resume and the post-run completion check

#### Scenario: Partial export cannot complete outputs (AC-15.31)

- **WHEN** only part of the concrete export package exists, any required artifact is empty, a source/output hash or KiCad `.gbrjob` file list differs from the successful-export receipt, or the source board no longer passes DRC
- **THEN** outputs remains incomplete and `create` does not advance to firmware
