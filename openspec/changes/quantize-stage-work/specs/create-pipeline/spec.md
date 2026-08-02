# create-pipeline delta spec

## ADDED Requirements

### Requirement: Per-stage token and wall budgets

`.copperhead/config.json` SHALL accept an optional `stageBudgets` map from stage
name to `{ maxTokensOut?, maxWallMs?, maxTurnOut? }`, and `create` SHALL pass a
stage's entry to that stage's run. `maxTokensOut` and `maxWallMs` SHALL be
enforced by the agent loop and end the run with exit path
`token-budget-exhausted` or `wall-budget-exhausted` respectively. Invalid entries
(non-positive, non-integer) SHALL be dropped rather than applied. Stages with no
entry SHALL run without a spend budget.

#### Scenario: A stage that overspends output tokens stops

- **WHEN** `stageBudgets.schematic.maxTokensOut` is 120000 and the stage's cumulative output passes it
- **THEN** the run ends with exit path `token-budget-exhausted` and the pipeline reports that stage as failed

#### Scenario: A malformed budget is ignored

- **WHEN** `stageBudgets` contains `{"schematic": {"maxTokensOut": 0}}`
- **THEN** the entry is dropped and the stage runs without a token budget

#### Scenario: A stage without an entry is unaffected

- **WHEN** `stageBudgets` names only `schematic` and the architecture stage runs
- **THEN** the architecture stage's run receives no spend budget

### Requirement: Stage prompts carry computed progress

For stages whose work is a countable set of units, `create` SHALL append a
computed progress line to the stage prompt naming how many units are already
present in repo state and which are missing, and SHALL recompute it before each
attempt. The schematic stage SHALL count BOM.md refdes rows present as schematic
symbols; the layout-draft stage SHALL count schematic symbols present as board
footprints. Stages with no countable unit list SHALL be unchanged.

#### Scenario: A resumed schematic stage is told what is left

- **WHEN** the schematic stage runs against a schematic that already holds 18 of the 32 refdes rows in BOM.md
- **THEN** the stage prompt states that 18 of 32 parts are present and names missing refdes

#### Scenario: No unit list means no progress line

- **WHEN** the spec-seed stage runs
- **THEN** its prompt is unchanged

## MODIFIED Requirements

### Requirement: Per-stage cost summary

The pipeline SHALL print and persist a per-stage cost summary. In addition to wall
time, turns, tokens and cache-hit rate, the persisted `report.json` and `REPORT.md`
SHALL carry, per stage, the turn-cost concentration figures `p50TurnOut`,
`p95TurnOut`, `maxTurnOut`, `top5TurnShare` and `slowestTurnMs`, and the edit
pressure figures `editBytesPerVerify` and `largestEditBytes`. Values SHALL be
`null` for stages that were resumed rather than run.

#### Scenario: Concentration is reported per stage

- **WHEN** a create run completes any stage
- **THEN** that stage's row in `report.json` carries `p50TurnOut`, `p95TurnOut`, `maxTurnOut`, `top5TurnShare`, `slowestTurnMs`, `editBytesPerVerify` and `largestEditBytes`

#### Scenario: A resumed stage reports null, not zero

- **WHEN** a stage was already complete on entry and was skipped past
- **THEN** every concentration and edit-pressure figure on its row is `null`

#### Scenario: REPORT.md shows the concentration table

- **WHEN** `REPORT.md` is regenerated at the end of a run
- **THEN** it contains a turn-cost concentration table alongside the existing cost table
