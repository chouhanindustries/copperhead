# agent-core — Delta Spec

## ADDED Requirements

### Requirement: `check_legibility` tool

The tool list SHALL include `check_legibility`, available in the same phase as `verify_symbols` and taking no required arguments. It SHALL run the deterministic legibility checker against the configured schematic and return either a statement that no findings exist or a numbered list of findings, each naming its kind, severity, sheet, coordinates, affected refdes, and the concrete fix. When no schematic is configured, it SHALL say so rather than failing.

#### Scenario: Clean schematic

- **WHEN** the agent calls `check_legibility` against a schematic with no defects
- **THEN** the result states the sheet count checked and that there are no findings

#### Scenario: Findings are actionable

- **WHEN** the checker finds overlapping symbol bodies
- **THEN** the result numbers the finding, names both refdes and their coordinates, and states the minimum separation required

#### Scenario: No schematic configured

- **WHEN** `check_legibility` runs in a repo whose config names no schematic
- **THEN** the result states that no schematic is configured and the run continues

### Requirement: Legibility findings feed the sync-obligations ledger

An error-severity legibility finding outstanding at the time `finish` is called SHALL be reported by `finish` as an unmet obligation, in the same list that already carries drift, constraint dual-write, and verification obligations. The obligation SHALL follow the ledger's existing edit-reopens, clean-run-clears lifecycle: a schematic edit opens (or re-opens) the legibility obligation through the same post-tool-call hook that re-opens the ERC and drift obligations, a `check_legibility` run with zero error-severity findings clears it, and a run with error-severity findings leaves it open carrying the current finding list. "Outstanding" therefore always means the most recent checker result against the file as edited, never a stale finding list, and `finish` and the stage-completion recheck judge the same state.

#### Scenario: `finish` refuses while the sheet is illegible

- **WHEN** the agent calls `finish` with outcome "done" while error-severity legibility findings remain
- **THEN** `finish` lists the outstanding findings as unmet obligations and the run does not conclude as done

#### Scenario: Clean rerun clears the obligation

- **WHEN** error-severity findings were recorded, the agent edits the schematic to fix them, and `check_legibility` runs again with zero error-severity findings
- **THEN** the legibility obligation is cleared and `finish` no longer lists it

#### Scenario: Edit re-opens the obligation

- **WHEN** `check_legibility` has run clean and the agent then edits the schematic again
- **THEN** the legibility obligation re-opens and stays open until the checker runs clean against the edited file
