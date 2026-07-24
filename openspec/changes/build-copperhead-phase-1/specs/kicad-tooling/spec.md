# kicad-tooling — Delta Spec

## ADDED Requirements

### Requirement: kicad-cli wrapper
The system SHALL wrap `kicad-cli` as a subprocess for ERC (`sch erc`), DRC (`pcb drc`), and SVG export, using `--format json --exit-code-violations` for checks, and SHALL detect the installed kicad-cli version at startup and fail with a clear message if absent or unsupported.

#### Scenario: ERC on a clean schematic
- **WHEN** `run_erc` executes against the fixture schematic
- **THEN** it returns `{ violations: [] }` and the underlying process exit code is 0

#### Scenario: kicad-cli missing
- **WHEN** kicad-cli is not on PATH
- **THEN** the command exits non-zero with a message naming the missing dependency, without a stack trace

### Requirement: Structured violation reports
ERC and DRC JSON reports SHALL be normalized into a single structured shape including severity, type, description, and sheet/position where available.

#### Scenario: Violation carries location
- **WHEN** the fixture schematic contains an unconnected pin and `run_erc` executes
- **THEN** the returned violation includes its type, description, and sheet/location fields

### Requirement: Read-only s-expression parsing
The system SHALL parse `.kicad_sch` files read-only to provide `list_symbols` (ref, value, footprint, sheet) and `list_nets` (net names); it SHALL NOT serialize or regenerate KiCad files. Pin-to-net connectivity SHALL recognize labels and explicit junction endpoints placed anywhere on a wire segment. `power:PWR_FLAG` SHALL declare external drive without becoming the net name.

#### Scenario: Symbols match the schematic
- **WHEN** `list_symbols` runs on the fixture schematic
- **THEN** it returns one entry per schematic symbol with real refdes, value, and footprint matching the file content

#### Scenario: Hierarchical sheets
- **WHEN** the schematic has multiple sheets
- **THEN** `list_symbols` includes symbols from every sheet with their sheet attribution

#### Scenario: Mid-segment label with power flag
- **WHEN** a net label lies at the midpoint of a wire between a component pin and `power:PWR_FLAG`
- **THEN** the pin resolves to the label's net name and `PWR_FLAG` is not returned by `list_nets`

### Requirement: SVG export
The system SHALL export schematic and board SVGs via kicad-cli for rendering and before/after diffing.

#### Scenario: Export produces a file
- **WHEN** `export_svg` runs for the schematic
- **THEN** an SVG file exists at the returned path
