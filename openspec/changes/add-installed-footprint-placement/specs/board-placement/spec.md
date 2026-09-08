# Board placement

## ADDED Requirements

### Requirement: Import installed footprints with schematic nets

The system SHALL provide a spec-gated populate_board tool that imports installed footprint geometry for configured schematic references at requested positions.

#### Scenario: Valid placement

- **GIVEN** a validated proposal and resolvable schematic footprint assignments
- **WHEN** populate_board receives unique references and finite coordinates
- **THEN** the board contains the installed geometry and corresponding pad nets with deterministic instance IDs
- **AND** existing board geometry is preserved and ERC/DRC obligations are opened

#### Scenario: Missing or ambiguous assignment

- **GIVEN** a missing footprint, ambiguous mapping, duplicate placement or existing board reference
- **WHEN** populate_board is called
- **THEN** the call fails without writing the board

#### Scenario: Edits locked

- **GIVEN** no validated proposal
- **WHEN** tools are listed or populate_board is dispatched
- **THEN** the tool is unavailable

### Requirement: Discover installed footprint names

The system SHALL expose read-only search_footprints returning at most 50 matching installed library IDs without accepting arbitrary filesystem paths.

#### Scenario: Search before proposal validation

- **GIVEN** installed KiCad footprint libraries
- **WHEN** the agent searches for a footprint name before edits are unlocked
- **THEN** matching installed IDs are returned without modifying the repository
- **AND** availability is not represented as component compatibility verification
