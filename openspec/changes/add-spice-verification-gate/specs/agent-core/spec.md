# agent-core — Delta Spec

## MODIFIED Requirements

### Requirement: Loop sequence
Each `do` run SHALL follow the sequence: load memory (all `docs/*.md` + schematic file list into context) → plan → edit → verify (ERC always; DRC if the board changed; the SPICE gate for any touched subsystem flagged by a `## Simulation` block, when ngspice is available) → repair → propagate (`check_drift`) → rationale → commit. SPICE assertion violations SHALL enter the same repair loop as ERC/DRC violations, under the same `maxRepairCycles` and rollback rules.

#### Scenario: Docs loaded before planning
- **WHEN** a `do` run starts
- **THEN** the transcript shows every `docs/*.md` file included in the system context before the first plan or edit

#### Scenario: Propagating rename (AC-3.1)
- **WHEN** `do "rename net KEY_DAH to KEY_DASH"` completes
- **THEN** the net is renamed in every sheet, PINOUT.md and SUBSYSTEMS.md are updated, ERC exits 0, exactly one commit exists, and no unrelated net or doc line changed

#### Scenario: SPICE gate joins verify for flagged subsystems
- **WHEN** a `do` run edits a sheet covered by a `## Simulation` block and ngspice is installed
- **THEN** the transcript shows the SPICE gate running in the verify step, and a failed assertion triggers the repair loop exactly as an ERC violation would

#### Scenario: Rollback includes SPICE failures
- **WHEN** SPICE assertion violations persist after `maxRepairCycles`
- **THEN** the working tree is restored byte-identical to the pre-run state and the run exits non-zero
