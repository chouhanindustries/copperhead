# create-pipeline — Delta Spec

## ADDED Requirements

### Requirement: Brief-to-package pipeline
`copperhead create --brief <file>` SHALL run the staged pipeline — seed `openspec/specs/` from the brief, write SPEC.md budgets, architecture (SUBSYSTEMS.md), part selection (BOM.md), schematic sheet by sheet, first-draft layout, outputs package, firmware scaffold, DEVPLAN.md — where each stage is a `do`-loop run with a stage-specific prompt and gate (spec self-consistency, drift, ERC per sheet, DRC, export success, firmware build).

#### Scenario: Full run yields the package
- **WHEN** `create` completes on a valid brief
- **THEN** `outputs/` contains gerbers+drill zip, DXF/STEP outline, SVG renders, ordering BOM csv, firmware scaffold, pins.h, and DEVPLAN.md, and the KiCad files are ERC/DRC clean

#### Scenario: Unstated decisions flagged
- **WHEN** the brief omits a needed decision (e.g. battery chemistry)
- **THEN** SPEC.md proposes a default flagged `ASSUMED` for review

### Requirement: Run-to-completion guarantee
Once started, `create` SHALL always finish with the complete output package: gates are quality checks the agent must satisfy, never stops that wait for a human, unless `--interactive` re-enables the spec-approval and pre-export gates.

#### Scenario: Autonomous by default
- **WHEN** `create` runs without `--interactive`
- **THEN** no stage blocks on human input and the run ends with all artifacts on disk

#### Scenario: Failed stage retained for debugging
- **WHEN** a stage fails during `create --keep-on-fail`
- **THEN** the pipeline stops with a non-zero result, creates no failure commit, leaves that stage's failed tree in place, prints the snapshot refs and manual recovery command, and warns that recovery is required before rerunning

### Requirement: Resumability from repo state
Pipeline state SHALL live in the repo (docs + files + gate results), so a killed `create` re-run SHALL continue from the first incomplete stage without redoing completed ones. Before inspecting completion markers, `create` SHALL refuse foreign command-entry changes. It MAY accept recognized Copperhead-managed artifacts for stage-gated resume and SHALL accept the resolved `--brief` as uncommitted input. It SHALL preserve that brief across a first-stage rollback. A `--keep-on-fail` stage SHALL leave a durable ignored marker that makes the next `create` refuse every retained dirty path before completion detection until manual recovery leaves only the brief dirty.

#### Scenario: Resume after kill
- **WHEN** `create` is killed after the BOM stage and re-run
- **THEN** it skips spec/architecture/BOM and resumes at the schematic stage

#### Scenario: Resume managed completed artifacts
- **WHEN** a hard-killed run leaves only Copperhead-managed stage artifacts dirty and their completion gates pass
- **THEN** `create` may commit the completed stage through the guarded resume path and continue

#### Scenario: Rerun after kept failure is blocked
- **WHEN** a kept failed stage leaves a dirty partial marker such as `firmware/` or `outputs/` and `create` is run again
- **THEN** `create` refuses before evaluating `isComplete`, explains that partial output may be unverified, and requires recovery to a clean tree

#### Scenario: Agent success still fails the stage contract
- **WHEN** an agent-loop run reports success and commits, but the stage's `isComplete` contract remains false
- **THEN** default mode restores the last completed pipeline state, while `--keep-on-fail` rewinds the new commit, retains its staged files, writes the kept-failure marker, and returns non-zero

#### Scenario: Untracked in-repo brief is valid input
- **WHEN** the resolved `--brief` file is untracked inside the repository and no other path is dirty
- **THEN** `create` accepts the input, evaluates stage completion normally, and preserves the exact brief contents if the first stage rolls back

#### Scenario: Ordinary first-stage rollback remains resumable
- **WHEN** the first stage fails or refuses without keeping failed output after OpenSpec bootstrap dirtied the tree
- **THEN** `create` restores the command-entry snapshot (plus the original brief when it was the allowed untracked input) so its next invocation passes the entry preflight

### Requirement: First-draft layout with honesty gate
The layout stage SHALL produce rule-driven placement (real coordinates in the `.kicad_pcb`) and rule-based routing of power/critical nets, with every routed net passing DRC, and SHALL auto-write a `## Draft quality` section in LAYOUT.md listing what is done and what a human or specialist tool should redo.

#### Scenario: Draft labeled
- **WHEN** the layout stage completes
- **THEN** LAYOUT.md contains a `## Draft quality` section and the board passes DRC

### Requirement: Firmware verification gate
The firmware scaffold SHALL compile clean against the vendor toolchain when one is available; when the toolchain is absent, the run SHALL still complete, marking DEVPLAN.md that the firmware was not compiled locally.

#### Scenario: Toolchain present
- **WHEN** the firmware stage runs with the vendor toolchain installed
- **THEN** the build exits 0 before the stage is marked complete

#### Scenario: Toolchain absent
- **WHEN** no vendor toolchain is installed
- **THEN** the scaffold and pins.h are still produced and DEVPLAN.md carries an explicit "not compiled here" flag
