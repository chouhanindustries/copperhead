# add-symbol-pin-dossier: Tasks

## 1. Unit count in symbol resolution

- [x] 1.1 `resolveLibrarySymbol` additionally reports `units`: the highest unit index among the resolved symbol's `Name_<unit>_<style>` children (1 for single-unit), read from the node whose pins are returned
- [x] 1.2 Tests: single-unit, multi-unit, and `extends`-derived symbols report the right count

## 2. `bomSymbolDossier`

- [x] 2.1 New `src/kicad/dossier.ts`: parse the BOM via the shared `parseBomTable`, group rows by query (MPN with the UNVERIFIED flag word stripped, else Value), skip pure-passive refdes classes (R/C/L)
- [x] 2.2 Per query: `searchInstalledSymbols`, resolve the top hit's pins, render refdes + query + lib_id + pin table (number=name/type, numeric-aware pin order), MULTI-UNIT flag, alternative candidates, or the NO-INSTALLED-SYMBOL line
- [x] 2.3 Size cap with named overflow ("NOT INCLUDED … use symbol_pins"), never silent truncation
- [x] 2.4 Never throws: bad BOM, unreadable library, or empty search dirs degrade to `''`
- [x] 2.5 Tests: MPN and Value resolution, passive omission, no-symbol line, multi-unit flag, cap disclosure, empty on no BOM table

## 3. `symbol_pins` agent tool

- [x] 3.1 Schema + handler in `src/agent/tools.ts`, `requiresUnlock: false`: resolved → pin table + unit count (+ multi-unit warning); no-symbol → in-library closest + cross-library matches; no-library → cross-library matches
- [x] 3.2 Tests for all three outcomes through the tool handler

## 4. Pipeline wiring

- [x] 4.1 `create.ts`: build the dossier block per schematic-stage attempt (BOM can change under a rollback), append to the stage prompt, `try/catch` to no-block
- [x] 4.2 Stage-4 prompt: point at the dossier and `symbol_pins` as the pin source; direct the agent away from reading `.kicad_sym` files
- [x] 4.3 Stage-3 prompt: require `symbol_pins` single-unit confirmation alongside the existing `search_symbols` requirement
- [x] 4.4 Typecheck, full suite, build green
