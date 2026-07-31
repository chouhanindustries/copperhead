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

`check --json` SHALL emit a `legibility` object of the shape `{findings, counts, skipped, disabled}`: `findings` is an array of checker findings, each `{kind, severity, sheet, at: {x, y}, refs, detail}` where `kind` is one of the checker's stable kind identifiers, `severity` is `error` or `advisory`, `sheet` and `detail` are strings, `at` carries millimetre coordinates, and `refs` is an array of strings; `counts` is `{error, advisory}` with integer totals; `skipped` is an array of `{family, reason}` records for checks not evaluated (for example page-relative checks on an unrecognized paper size); `disabled` is an array of family identifiers turned off in config. The `legibility` key SHALL always be present: with empty arrays and zero counts when the schematic is clean, and with every family recorded as skipped when no schematic is configured.

#### Scenario: Machine-readable findings

- **WHEN** `check --json` runs on a repo with two error-severity findings
- **THEN** stdout contains a `legibility` object listing both findings with their kind, severity, sheet, and coordinates, and a count of 2 at error severity

#### Scenario: No schematic configured

- **WHEN** `check --json` runs in a repo whose config names no schematic
- **THEN** the `legibility` object is present with an empty findings list, zero counts, and every family recorded as skipped
