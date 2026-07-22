# docs-memory delta spec

## ADDED Requirements

### Requirement: Zero-symbol schematics are bootstrap state, not drift

`checkDrift` SHALL report no mismatches when the schematic contains zero symbols: during the create pipeline the docs legitimately lead the schematic (part-selection writes BOM.md before any symbol exists), and gating on an empty sheet deadlocks every docs-touching stage. To keep `check` honest on established repos, `check` SHALL surface a non-failing warning when the schematic has zero symbols while BOM.md lists refdes rows.

#### Scenario: Docs may lead an empty schematic (AC-15.25)

- **WHEN** BOM.md lists parts and the configured schematic contains zero symbols
- **THEN** `checkDrift` returns no mismatches and in-run drift obligations do not block finish

#### Scenario: check warns without failing (AC-15.26)

- **WHEN** `copperhead check` runs against a zero-symbol schematic with a populated BOM.md
- **THEN** the drift gate still passes, and the output (and JSON `drift.warning`) carries a warning naming the zero-symbol/BOM mismatch
