# schematic-emission — Delta Spec

## ADDED Requirements

### Requirement: Installed-library verification distinguishes generated power symbols

`verify_symbols` SHALL compare ordinary embedded symbols with their installed KiCad library sources. It SHALL exclude an engine-generated rail, ground, or `PWR_FLAG` symbol only when the entry uses the reserved `copperhead_power` namespace and matches the generated ownership and electrical-semantic shape. Such an entry SHALL count as neither installed-library verified nor skipped for a missing installed library.

A prefixed entry that does not match the generated semantic shape SHALL remain subject to normal installed-library verification. Ordinary vendored symbols SHALL continue to report pin divergence from their installed sources.

#### Scenario: Drafted power symbols do not produce alias findings

- **WHEN** the deterministic engine drafts power-class nets and synthesizes a `PWR_FLAG`
- **THEN** `verify_symbols` reports no installed-library divergence for their exact generated `copperhead_power` entries
- **AND** does not count those entries as installed-library checked or unavailable

#### Scenario: Altered private-prefix entry is not trusted

- **WHEN** a `copperhead_power` entry has an electrical type, identity property, token relationship, or pin shape that differs from the generated form
- **THEN** `verify_symbols` subjects it to normal installed-library resolution and reports the applicable finding

#### Scenario: Ordinary vendored drift remains visible

- **WHEN** an ordinary vendored symbol such as `Device:R` differs from its installed library source
- **THEN** `verify_symbols` reports the existing pin divergence
