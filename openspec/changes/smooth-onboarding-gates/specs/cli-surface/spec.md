# cli-surface — Delta Spec

## MODIFIED Requirements

### Requirement: Command set
The `copperhead` CLI SHALL provide the commands `create [brief] [--brief <file>]`, `init [--path <dir>]`, `do "<change request>"`, `check`, `sync`, and `export bom --supplier <jlcpcb|digikey|mouser> [--boards <n>] [--spares <percent>] [--include-unverified]`, plus the global flags `--repo <path>`, `--dry-run`, and `--json`.

#### Scenario: Help lists all Phase 1 commands
- **WHEN** `copperhead --help` is run
- **THEN** the output lists `create`, `init`, `do`, `check`, `sync`, and `export` with one-line descriptions and the global flags

#### Scenario: Unknown command
- **WHEN** an unrecognized command is invoked
- **THEN** the CLI exits non-zero with a usage message and no stack trace

#### Scenario: export bom flag validation
- **WHEN** `export bom` is invoked with an unknown `--supplier` value
- **THEN** the CLI exits non-zero listing the supported suppliers

### Requirement: create accepts the brief as text or as a file
`copperhead create` SHALL accept the brief either as a positional argument or via `--brief <file>`, and SHALL NOT require `--brief`.

#### Scenario: Brief given as text
- **WHEN** `copperhead create "a 4-key USB-C macro keypad"` is run
- **THEN** the text is written to a markdown file in the repo and the pipeline runs against it, with stage 1's prompt carrying that text

#### Scenario: Positional argument naming an existing file
- **WHEN** `copperhead create brief.md` is run and `brief.md` exists
- **THEN** that file is used as the brief and no new brief file is written

#### Scenario: Neither form given
- **WHEN** `copperhead create` is run with no positional argument and no `--brief`
- **THEN** the CLI exits non-zero with a usage line showing both forms

#### Scenario: Named brief file is missing
- **WHEN** `--brief <file>` names a path that does not exist
- **THEN** the command exits non-zero with an error naming that path, before any repo state is changed
