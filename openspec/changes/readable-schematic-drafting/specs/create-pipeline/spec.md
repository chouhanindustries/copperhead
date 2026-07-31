# create-pipeline — Delta Spec

## ADDED Requirements

### Requirement: Schematic stage states the drafting standard

The schematic stage's instruction SHALL state the drafting standard the sheet must satisfy before the agent begins placing symbols: one drawn group box with a caption per subsystem taken from SUBSYSTEMS.md, groups tiled without overlap with a large MCU or connector given its own full-height column, left-to-right signal flow within a group, power rails toward the top and grounds toward the bottom, symbol pitch that leaves room for the refdes and value text of both neighbours, net labels rather than long wires for connections between groups, spare gates and unused sections placed in their own annotation group, a paper size chosen so the groups fill the frame, and a populated title block.

#### Scenario: Standard is present in the stage instruction

- **WHEN** the schematic stage builds its prompt
- **THEN** the instruction text states the group-box, block-partitioning, inter-group labelling, page-sizing, and title-block rules

### Requirement: Schematic stage reconciles legibility findings

The schematic stage SHALL instruct the agent to run the legibility checker after symbols are placed and to reconcile every error-severity finding before finishing, under the same reconcile obligation that already applies to symbol verification. Advisory findings SHALL be surfaced to the agent but SHALL NOT block finishing.

#### Scenario: Agent is told to reconcile

- **WHEN** the schematic stage builds its prompt
- **THEN** the instruction directs the agent to run the legibility check and resolve every error-severity finding it reports

## MODIFIED Requirements

### Requirement: Content-aware stage completion

Stage completion SHALL be judged by repo state, not artifact existence alone: the schematic stage is complete only when the configured schematic contains at least one symbol AND the BOM/PINOUT tables are drift-clean against it AND ERC passes AND the schematic reports zero error-severity legibility findings; the layout-draft stage is complete only when a configured board exists containing at least one footprint AND the LAYOUT.md draft-quality marker is present. After a stage's agent run finishes with outcome success, `create` SHALL re-check that stage's completion contract and halt the pipeline (preserving committed partial work, with a resume hint) if the contract is not met, instead of advancing to later stages.

#### Scenario: Blank sheet does not complete the schematic stage (AC-15.23)

- **WHEN** the schematic stage's run succeeds but the configured schematic contains zero symbols
- **THEN** `create` reports the stage contract as unmet, does not advance, and a re-run of `copperhead create` resumes at the schematic stage

#### Scenario: Pipeline halts on planning-only output (AC-15.24)

- **WHEN** any stage's agent run returns success without satisfying that stage's completion contract
- **THEN** `runCreate` returns not-ok with the completed-stage list so far, and later stages do not run

#### Scenario: Illegible sheet does not complete the schematic stage

- **WHEN** the schematic stage's run succeeds with symbols present and drift clean, but the checker reports error-severity legibility findings
- **THEN** `create` reports the stage contract as unmet with the finding counts by kind, does not advance, and a re-run resumes at the schematic stage

#### Scenario: Advisory findings do not block the stage

- **WHEN** the schematic reports only advisory legibility findings
- **THEN** the stage completes and the advisories are recorded in the run summary
