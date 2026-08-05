# cli-surface delta spec

## ADDED Requirements

### Requirement: `create` accepts a turn budget

`copperhead create` SHALL accept `--max-turns <n>`, validated as a positive
integer with the same parser the other commands use, and SHALL apply it as the
per-stage turn budget. A `stageMaxTurns` entry in config SHALL still override it
for that stage.

#### Scenario: Flag sets the budget for stages without a config entry

- **WHEN** `copperhead create --brief b.md --max-turns 120` runs in a repo with no `stageMaxTurns`
- **THEN** every stage runs with a 120-turn budget

#### Scenario: Bad value refuses to start

- **WHEN** `--max-turns 5oops` is passed
- **THEN** the command exits non-zero with a message naming the flag, before any provider call

## MODIFIED Requirements

### Requirement: Attended budget-exhaustion prompt

When the turn budget runs out, a run whose **stdin** is a TTY SHALL ask whether to
continue, showing turns used, token usage, files touched, and open obligations, and
SHALL grant `ceil(originalBudget / 2)` more turns on acceptance. The question SHALL
be written to stderr whenever stdout is not a TTY, so a piped or redirected run
keeps the escape hatch. A run with no TTY on stdin (CI) SHALL keep fail-and-restore
behaviour unchanged.

#### Scenario: A piped run still gets asked

- **WHEN** `copperhead create --brief b.md | tee run.log` exhausts a stage's budget with stdin attached to a terminal
- **THEN** the continue question appears on stderr and answering `y` grants more turns

#### Scenario: An attended run keeps asking on stdout

- **WHEN** both stdin and stdout are TTYs
- **THEN** the question appears on stdout as before

#### Scenario: CI is unattended

- **WHEN** stdin is not a TTY
- **THEN** budget exhaustion fails and restores without asking
