# fix-generated-power-symbol-verification: Design

## Context

The drafter intentionally authors power symbols rather than copying KiCad's installed `power` library. This makes arbitrary rail names deterministic and lets ERC work on machines whose stock power library naming differs. The emitted `copperhead_power` nickname therefore describes engine ownership, not a canonical-library claim.

`verify_symbols` resolves every embedded `lib_symbols` identifier against installed libraries. An exact generated `copperhead_power:GND` consequently appears to be a wrong-library spelling of `power:GND`, even though replacing it would abandon the drafter's hermetic contract.

## Goals / Non-Goals

**Goals:**

- Prevent false installed-library findings for exact engine-generated power symbols.
- Keep the private prefix from becoming a blanket trust exemption.
- Preserve installed-library comparison for ordinary vendored symbols.

**Non-Goals:**

- No replacement with stock `power:*` symbols.
- No weakening of ERC, drift, or ordinary symbol-pin verification.
- No claim that generated symbols were verified against an installed library.

## Decisions

- **D1: Recognize semantic shape, not prefix alone.** An exempt entry must use the reserved namespace and carry the markers, properties, value/token relationship, single pin, pin number, pin name, and electrical type emitted for a rail/ground or `PWR_FLAG`. A malformed or altered prefixed entry falls through to normal verification.
- **D2: Do not count generated entries as checked or skipped.** `checked` means comparison with an installed symbol succeeded; `skipped` means an installed library was unavailable. Neither describes an engine-owned symbol with no canonical installed identity.
- **D3: Keep drift detection unchanged.** Ordinary entries such as `Device:R` still resolve against the installed source and report pin divergence after a library upgrade.

## Risks / Trade-offs

- Recognition duplicates the small semantic signature of generated power symbols. Focused integration coverage against actual drafted output guards that contract.
- Geometry is outside `verify_symbols`' pin-fidelity purpose. The recognizer validates the ownership and electrical semantics relevant to this checker; schematic loading, ERC, and legibility retain their existing geometry checks.

## Migration Plan

No repository migration is required. Existing generated schematics stop producing false alias findings on their next verification run.
