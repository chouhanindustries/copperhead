# run-observability delta spec

## ADDED Requirements

### Requirement: Turn-cost concentration is computed from per-turn rows

A pure function SHALL summarize a list of per-turn `{turn, in, out, ms}` rows into
`p50TurnOut`, `p95TurnOut`, `maxTurnOut`, `top5TurnShare` (the fraction of total
output emitted by the five largest turns) and `slowestTurnMs`. Percentiles SHALL
use nearest-rank over the sorted output values. An empty list SHALL produce zeroed
figures rather than throw.

#### Scenario: The historical schematic run reproduces its published figures

- **WHEN** the 40 per-turn output values of run `2026-07-29T18-02-20-554Z` are summarized
- **THEN** `p50TurnOut` is 177, `maxTurnOut` is 43629, and `top5TurnShare` rounds to 0.89

#### Scenario: An empty run is not an error

- **WHEN** a run recorded no turns
- **THEN** the summary reports zeros and `slowestTurnMs` of `null`

### Requirement: Concentration and edit pressure are recorded on every terminal path

The `run-end` event and `summary.md`'s run-stats section SHALL carry the turn-cost
concentration figures and the run's edit-pressure figures (`edits`, `editBytes`,
`largestEditBytes`, `verifications`, `editBytesPerVerify`).

#### Scenario: A failed run still reports concentration

- **WHEN** a run ends with `turn-budget-exhausted`
- **THEN** its `run-end` event carries the concentration figures and `summary.md` renders them

### Requirement: Historical transcripts can be scored without new instrumentation

Reading an existing run directory SHALL yield its concentration and edit-pressure
figures from the recorded `run-end` and `tool` events alone, so runs recorded before
this change can be replayed and compared.

#### Scenario: An old transcript is scored

- **WHEN** a run directory whose `run-end` event has per-turn rows without `ms` is read
- **THEN** the token concentration figures are produced and `slowestTurnMs` is `null`
