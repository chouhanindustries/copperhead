# agent-core — Delta Spec

## ADDED Requirements

### Requirement: `check_legibility` tool

The tool list SHALL include `check_legibility`, available in the same phase as `verify_symbols` and taking no required arguments. It SHALL run the deterministic legibility checker against the configured schematic and return either a statement that no findings exist or a numbered list of findings, each naming its kind, severity, sheet, coordinates, affected references, and the concrete fix. References are the finding's `refs` and are not limited to refdes: a `group-overlap` finding names the two group captions, `empty-title-block` names the empty fields, and page-level findings such as `low-utilization` name the sheet, so a finding with no symbol involved still says what it is about. When no schematic is configured, it SHALL say so rather than failing.

#### Scenario: Clean schematic

- **WHEN** the agent calls `check_legibility` against a schematic with no defects
- **THEN** the result states the sheet count checked and that there are no findings

#### Scenario: Findings are actionable

- **WHEN** the checker finds overlapping symbol bodies
- **THEN** the result numbers the finding, names both refdes and their coordinates, and states the minimum separation required

#### Scenario: No schematic configured

- **WHEN** `check_legibility` runs in a repo whose config names no schematic
- **THEN** the result states that no schematic is configured and the run continues

#### Scenario: Non-symbol finding is still actionable

- **WHEN** the checker finds an empty title block
- **THEN** the numbered finding names the empty fields as its references and states what to fill in, with no refdes required

### Requirement: `check_legibility` joins the verification sequence

The agent loop's stated workflow SHALL include `check_legibility` in the verification steps that precede `finish`, alongside ERC, DRC, and the drift check: after schematic edits, the prompt SHALL direct the agent to run `check_legibility` and reconcile error-severity findings in the same loop that already requires a clean ERC, rather than leaving the checker as a tool the agent may never call.

#### Scenario: Prompt names the checker before finish

- **WHEN** the agent loop's prompt states the verification steps a schematic-editing run must complete before `finish`
- **THEN** `check_legibility` is listed with `run_erc` and `check_drift`, with the instruction to reconcile error-severity findings

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
