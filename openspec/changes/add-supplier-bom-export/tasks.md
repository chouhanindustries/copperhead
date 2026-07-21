# Tasks: add-supplier-bom-export

## 1. Export core

- [ ] 1.1 Extract the BOM.md table parser from `src/memory/drift.ts` into a shared module and reuse it
- [ ] 1.2 Implement quantity arithmetic (`ceil(qty × boards × (1 + spares/100))`, passive minimum `qty × boards + 2` for `R_`/`C_`/`L_` footprint prefixes) with unit tests
- [ ] 1.3 Implement per-supplier emitters in `src/kicad/bom-export.ts`: JLCPCB assembly CSV, DigiKey cart CSV, Mouser cart CSV, each as one function
- [ ] 1.4 Implement exclusion rules: MPN-less rows always excluded, `UNVERIFIED` rows excluded unless `--include-unverified`; warnings footer to stderr and CSV comments where the format permits

## 2. CLI wiring

- [ ] 2.1 Add `src/commands/export.ts` with `export bom --supplier --boards --spares --include-unverified`; validate supplier values with a helpful error
- [ ] 2.2 Refuse export with a drift hint when the parsed BOM.md disagrees with the schematic parse
- [ ] 2.3 Wire the JLCPCB emitter into `create` stage 6 outputs

## 3. Tests

- [ ] 3.1 Golden-file tests per supplier format against the fixture BOM
- [ ] 3.2 Exclusion and `--include-unverified` behavior tests
- [ ] 3.3 Drift-refusal test (edited BOM.md value → non-zero exit, drift hint)
- [ ] 3.4 Network guard: no api.* connections during export

## 4. Docs

- [ ] 4.1 README: ordering section (`export bom` usage, quantity knobs, what gets excluded and why)
- [ ] 4.2 Decide and document the optional `LCSC` column in the BOM.md scaffold (design open question)
