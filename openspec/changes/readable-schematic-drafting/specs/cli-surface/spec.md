# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: `check` reports legibility advisories

`check` SHALL run the deterministic legibility checker over the configured schematic and report its findings grouped by severity. The findings SHALL NOT affect `check`'s exit code at any severity, so a repo that passes today continues to pass. `check` SHALL remain LLM-free and network-free with the checker included.

#### Scenario: Illegible schematic still exits zero

- **WHEN** `check` runs on a repo whose schematic has error-severity legibility findings but clean ERC and DRC
- **THEN** the findings are printed under a legibility heading and the exit code is 0

#### Scenario: Determinism is preserved

- **WHEN** `check` runs with the checker enabled
- **THEN** no language-model call and no network request is made

### Requirement: `--json` carries legibility findings

`check --json` SHALL emit a `legibility` key containing the finding list and per-severity counts, using the same stable kind identifiers the checker defines. The key SHALL be present with an empty finding list when there are no findings, and SHALL record which families were skipped or disabled.

#### Scenario: Machine-readable findings

- **WHEN** `check --json` runs on a repo with two error-severity findings
- **THEN** stdout contains a `legibility` object listing both findings with their kind, severity, sheet, and coordinates, and a count of 2 at error severity
