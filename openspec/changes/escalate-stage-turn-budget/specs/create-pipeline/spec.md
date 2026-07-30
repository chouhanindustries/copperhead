# create-pipeline delta spec

## ADDED Requirements

### Requirement: Turn budget escalates after budget exhaustion

When a create-pipeline stage attempt ends with exit path `turn-budget-exhausted`,
the pipeline SHALL raise the next attempt's turn budget by `ceil(previous / 2)`,
where `previous` is the budget that attempt just ran under, and SHALL log the
raise on its own stage line. Attempts that end by any other exit path SHALL retry
at the unchanged budget. When every attempt of the stage ended
`turn-budget-exhausted`, the stage's final message SHALL name the budget the
stage would need and the two places that set it.

#### Scenario: Second attempt gets more turns

- **WHEN** the schematic stage resolves a 40-turn budget and its first attempt exits `turn-budget-exhausted`
- **THEN** the second attempt runs with 60 turns and the third with 90

#### Scenario: The raise is visible

- **WHEN** an attempt is escalated
- **THEN** a stage line states the previous and the next budget

#### Scenario: Other failures do not escalate

- **WHEN** a stage attempt exits `provider-error` or finishes without meeting its completion contract
- **THEN** the next attempt runs with the same budget as the one before it

#### Scenario: Exhausting every attempt names the remedy

- **WHEN** every attempt of a stage exits `turn-budget-exhausted`
- **THEN** the stage's final log line states that the stage needs a larger budget and names `--max-turns` and `stageMaxTurns`

### Requirement: Stage failure diagnosis receives the structured exit path

`create` SHALL pass the failed attempt's `exitPath` to the recovery supervisor as
a structured field, alongside the prose failure description, and SHALL tell the
supervisor when a budget escalation is already scheduled for the next attempt.
The escalation itself SHALL remain deterministic: the supervisor's verdict set
stays `retry` / `abort` and never decides the budget.

#### Scenario: Budget exhaustion is distinguishable from a bad edit

- **WHEN** the supervisor is asked to diagnose an attempt that exited `turn-budget-exhausted`
- **THEN** its prompt contains `exitPath: turn-budget-exhausted` and states the budget the next attempt will receive

#### Scenario: No escalation, no budget line

- **WHEN** the supervisor is asked to diagnose an attempt that exited some other way
- **THEN** its prompt carries that exit path and no next-budget statement

### Requirement: Built-in per-stage turn budgets

The pipeline SHALL apply built-in default turn budgets for the stages known to
need more than the global default (`schematic`: 100, `layout-draft`: 80). Budget
resolution precedence SHALL be: `stageMaxTurns[stage]` from config, then the
`--max-turns` value passed to `create`, then the built-in per-stage default, then
the global `maxTurns`.

#### Scenario: Schematic stage gets its larger default

- **WHEN** a repo has no `stageMaxTurns` entry and no `--max-turns`
- **THEN** the schematic stage runs with the built-in default rather than the global `maxTurns`

#### Scenario: Config still overrides the flag per stage

- **WHEN** config sets `stageMaxTurns: {"schematic": 55}` and the run passes `--max-turns 120`
- **THEN** the schematic stage runs with 55 turns and every other stage with 120

#### Scenario: A stage with no entry anywhere uses the global budget

- **WHEN** the spec-seed stage runs in a repo with no `stageMaxTurns` and no `--max-turns`
- **THEN** it runs with the config's `maxTurns`
