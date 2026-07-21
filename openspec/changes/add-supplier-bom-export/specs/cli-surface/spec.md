# cli-surface — Delta Spec

## MODIFIED Requirements

### Requirement: Command set
The `copperhead` CLI SHALL provide the commands `create --brief <file>`, `init [--path <dir>]`, `do "<change request>"`, `check`, `sync`, and `export bom --supplier <jlcpcb|digikey|mouser> [--boards <n>] [--spares <percent>] [--include-unverified]`, plus the global flags `--repo <path>`, `--dry-run`, and `--json`.

#### Scenario: Help lists all Phase 1 commands
- **WHEN** `copperhead --help` is run
- **THEN** the output lists `create`, `init`, `do`, `check`, `sync`, and `export` with one-line descriptions and the global flags

#### Scenario: Unknown command
- **WHEN** an unrecognized command is invoked
- **THEN** the CLI exits non-zero with a usage message and no stack trace

#### Scenario: export bom flag validation
- **WHEN** `export bom` is invoked with an unknown `--supplier` value
- **THEN** the CLI exits non-zero listing the supported suppliers
