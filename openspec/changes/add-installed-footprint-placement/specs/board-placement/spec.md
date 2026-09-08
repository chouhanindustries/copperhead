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

The system SHALL expose read-only search_footprints returning at most 50 matching installed library IDs without accepting arbitrary filesystem paths. Exact and prefix name matches SHALL rank before other name matches. When no ID matches, metadata matching SHALL compare normalized query tokens with the union of the ID and declared `descr`/`tags`, normalizing separators and camel-case boundaries. Arbitrary footprint body content SHALL NOT produce metadata matches.

#### Scenario: Search before proposal validation

- **GIVEN** installed KiCad footprint libraries
- **WHEN** the agent searches for a footprint name before edits are unlocked
- **THEN** matching installed IDs are returned without modifying the repository
- **AND** availability is not represented as component compatibility verification

#### Scenario: Semantic metadata discovery

- **GIVEN** an installed footprint whose filename is a part number and whose declared description or tags say `power-only`
- **WHEN** the agent searches for `USB_C_Receptacle_PowerOnly`
- **THEN** the installed library ID is returned after any matching footprint names

#### Scenario: Geometry text is not metadata

- **GIVEN** a query appears only in a footprint pad or drawing text
- **WHEN** the agent searches for that query
- **THEN** that footprint is not returned solely because of the body text
