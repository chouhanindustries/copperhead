# Proposal: installed footprint placement

## Why

A real create stage5 run produced 76 DRC findings after the model invented footprint geometry. Existing tools expose footprint IDs but cannot import installed land patterns. The retry explicitly identified this missing capability.

## What Changes

- Add a spec-gated `populate_board` tool importing real installed footprint geometry and schematic pad nets at requested positions.
- Refuse invalid or missing definitions before any write and retain existing verification obligations.
- Require this import path in the layout prompt.

## Capabilities

### New Capabilities

- `board-placement`: deterministic installed footprint placement.

### Modified Capabilities

None.

## Impact

KiCad footprint helper, capability catalog, layout prompt, tests and central SPEC. No routing or relaxed DRC.
