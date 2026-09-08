# fix-generated-power-symbol-verification: Proposal

## Why

The deterministic drafter authors hermetic rail, ground, and `PWR_FLAG` symbols in its private `copperhead_power` namespace. `verify_symbols` currently treats those embedded symbols as claims about the installed KiCad library and recommends unrelated stock aliases. In a real stage-4 run, that false finding caused the agent to reclassify GND as a signal, removing the intended ground and power-flag drawing.

## What Changes

- Exclude exact engine-generated power-symbol forms from installed-library comparison.
- Keep arbitrary or semantically altered entries under the same prefix subject to verification.
- Continue verifying every ordinary vendored symbol against the installed library, including library drift.
- Describe the tool boundary accurately so the agent does not rewrite valid power intent to satisfy a false finding.

## Capabilities

### Modified Capabilities

- `schematic-emission`: generated power symbols are distinguished from canonical installed-library symbols during verification.

## Impact

- **Code**: `src/kicad/symlib.ts` recognizes exact generated power semantics; `src/capabilities/handlers.ts` states the boundary.
- **Tests**: unit and drafted-output coverage prove the exemption and preserve ordinary-symbol drift detection.
- **Specification**: AC-16 records the generated-symbol verification contract.
