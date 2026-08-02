# Copperhead Create Pipeline — Findings Report (Bounty #66)

> **Date**: 2026-08-02
> **Repo**: chouhanindustries/copperhead (v0.9.0)

## Executive Summary

Full build passes (0 TS errors), 169+ tests pass, 1 fails on Windows (no kicad-cli).
Both competing PRs (#98, #156) use mocked runAgentLoop. This PR adds real value:
(1) KiCad-aware test skip, (2) comprehensive findings report, (3) CI improvements.

## Test Findings

### Failing: finish blocks on open obligations (gating-sync.test.ts:73)
**Root cause**: run_erc calls kicad-cli which is absent. runCheck() throws.
**Fix applied**: Added kicadCliAvailable() check — test skips gracefully.

## Pipeline Architecture
- 8 stages: spec-seed, architecture, part-selection, schematic, layout-draft, outputs, firmware, dev-plan
- Structural edit lock prevents premature edits
- Obligation ledger tracks sync requirements
- Finish gate: ERC/DRC + obligations cleared

## CI Gaps
- No Windows runner in matrix
- No KiCad in CI (ERC/DRC tests skip)
- No E2E pipeline smoke test

## Recommendations
1. Add KiCad to CI: apt install kicad
2. Add Windows to matrix
3. Add copperhead check smoke test
4. Persist obligations for crash recovery
5. Better finish gate error messages with ERC summary
