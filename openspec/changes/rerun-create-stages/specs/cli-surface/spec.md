# cli-surface — Delta Spec

## MODIFIED Requirements

### Requirement: Dry-run mode
With `--dry-run`, `do` SHALL print the proposed diff and write no files. With `--dry-run`, `create` SHALL print each stage's classification (fresh, stale with the changed upstream artifacts, incomplete, or assumed-complete) and exactly which stages the invocation's mode (default, `--stage`, or `--from`) would run, then exit 0 having written nothing. `create --dry-run` is deterministic and SHALL require neither a configured model/API key nor `kicad-cli`; stage-name validation SHALL likewise run before model or `kicad-cli` resolution.

#### Scenario: Dry run writes nothing (AC-3.9)
- **WHEN** `do "<request>" --dry-run` completes
- **THEN** the proposed diff is printed and `git status` shows no changes

#### Scenario: create dry run reports the stale set
- **WHEN** `create --dry-run` runs in a repo where BOM.md changed after the schematic stage completed
- **THEN** the output classifies `schematic` as stale naming `bom`, lists the stages a default run would execute, and `git status` shows no changes

## ADDED Requirements

### Requirement: Targeted create stage flags
`create` SHALL accept `--stage <name>` (run one stage, then propagate) and `--from <name>` (force-re-run the stage and its graph descendants), mutually exclusive with each other. An unknown stage name SHALL exit non-zero listing the valid stage names, without starting a run.

#### Scenario: Unknown stage name
- **WHEN** `create --stage part-slection` is invoked
- **THEN** the CLI exits non-zero, names the invalid value, and lists the valid stage names

#### Scenario: Mutually exclusive flags
- **WHEN** `create --stage bom --from schematic` is invoked
- **THEN** the CLI exits non-zero with a usage message and no run starts
