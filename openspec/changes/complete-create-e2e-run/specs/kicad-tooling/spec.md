# kicad-tooling delta spec

## ADDED Requirements

### Requirement: Drift connectivity follows legal KiCad wire geometry

The read-only schematic parser SHALL connect pins, labels, and explicit wire
endpoints that lie anywhere on a wire segment, including a segment midpoint.
`power:PWR_FLAG` SHALL declare a driven net for ERC without becoming that
net's name in `listNets` or `pinNets`.

#### Scenario: Mid-segment label names a flagged net

- **WHEN** a label lies at the midpoint of a wire between a component pin and a `PWR_FLAG`
- **THEN** the component pin resolves to the label's name and `PWR_FLAG` is not listed as a net
