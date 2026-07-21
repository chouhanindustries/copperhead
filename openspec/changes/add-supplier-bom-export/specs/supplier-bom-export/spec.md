# supplier-bom-export — Delta Spec

## ADDED Requirements

### Requirement: Supplier-format BOM export
`copperhead export bom --supplier <jlcpcb|digikey|mouser>` SHALL read BOM.md and write a CSV in the named supplier's upload format: JLCPCB assembly CSV (Comment, Designator, Footprint, LCSC Part #), or DigiKey/Mouser cart CSV (MPN, manufacturer, quantity, customer reference). The export SHALL be deterministic and make zero LLM and zero network calls.

#### Scenario: JLCPCB export from fixture BOM
- **WHEN** `export bom --supplier jlcpcb` runs on the fixture repo
- **THEN** a CSV is written whose header and rows match the JLCPCB assembly format, with designators grouped per line

#### Scenario: DigiKey export carries quantities
- **WHEN** `export bom --supplier digikey --boards 5` runs
- **THEN** each CSV row's quantity equals the computed order quantity for five boards, and each row carries the MPN and manufacturer from BOM.md

### Requirement: Quantity arithmetic
Order quantity per line SHALL be `ceil(perBoardCount × boards × (1 + spares/100))` with `--boards` defaulting to 1 and `--spares` defaulting to 10, and SHALL be raised to `perBoardCount × boards + 2` for passive lines (footprint prefixes `R_`, `C_`, `L_`) when the percentage yields less.

#### Scenario: Spares percentage applied
- **WHEN** a line has 4 parts per board and `--boards 10 --spares 10` is passed
- **THEN** the exported quantity is 44

#### Scenario: Passive minimum applied
- **WHEN** a passive line has 1 part per board and `--boards 1 --spares 10` is passed
- **THEN** the exported quantity is 3

### Requirement: Unorderable rows are excluded and reported
Rows lacking an MPN and rows flagged `UNVERIFIED` SHALL be excluded from supplier files and listed in a warnings footer printed to stderr and appended as CSV comments where the format permits. `--include-unverified` SHALL include `UNVERIFIED` rows (but never MPN-less rows) and still report them.

#### Scenario: Missing MPN excluded
- **WHEN** BOM.md contains a row without an MPN and `export bom --supplier mouser` runs
- **THEN** the row is absent from the CSV and named in the warnings output

#### Scenario: --include-unverified opts in
- **WHEN** the same export runs with `--include-unverified` and BOM.md has an `UNVERIFIED` row with an MPN
- **THEN** the row appears in the CSV and is still named in the warnings output

### Requirement: BOM.md is the sole input
The export SHALL be produced from BOM.md, not from the schematic, and SHALL refuse with a drift hint when `check`-level BOM drift is detectable from the parsed tables.

#### Scenario: Drifted BOM refuses to export
- **WHEN** BOM.md disagrees with the schematic and `export bom` runs
- **THEN** the command exits non-zero telling the user to run `check` and resolve drift before ordering
