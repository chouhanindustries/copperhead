# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: `check` runs the SPICE gate
`copperhead check` SHALL run the SPICE gate for every subsystem flagged by a `## Simulation` block when ngspice is installed, report loud skips per the spice-verification capability when it is not, and include a stable `spice` key in `--json` output (per-assertion `{assertion, status, measured?, bound?}` entries plus the skip state). The gate SHALL keep `check` LLM-free and network-free.

#### Scenario: check verifies assertions
- **WHEN** `check` runs on the fixture with a passing `## Simulation` block and ngspice installed
- **THEN** the output shows the SPICE gate ✓ with the assertion count, and the exit code is 0

#### Scenario: check --json exposes spice results
- **WHEN** `check --json` runs on a flagged repo
- **THEN** the JSON contains a `spice` key with one entry per assertion, including measured values for evaluated assertions
