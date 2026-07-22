# kicad-tooling delta spec

## ADDED Requirements

### Requirement: Missing ERC/DRC reports surface kicad-cli's own error

When kicad-cli exits without producing the requested ERC/DRC report file, the wrapper SHALL raise an error that says the design file likely fails to load and includes kicad-cli's stderr/stdout, instead of an opaque report-file read error.

#### Scenario: Unloadable schematic explains itself at ERC time (AC-15.28)

- **WHEN** `run_erc` targets a schematic kicad-cli cannot load
- **THEN** the raised error names the likely load failure and quotes kicad-cli's output, not a raw ENOENT on the report path
