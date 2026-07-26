# Audit Findings & Verification Report

## BLOCKER

- **[B-1] Structural Lock Bypass Prevention**
  - **Citation**: [src/agent/tools.ts:L664-L666](file:///c:/Users/meeta/OneDrive/Desktop/copperhead/src/agent/tools.ts#L664-L666)
  - **Details**: Edit tools (`write_file`, `edit_file`) are locked by returning only non-edit tools in `availableTools()` until `ctx.editsUnlocked` is `true`. `propose_change` and `validate_change` must precede any file mutation.

## DEFECT

- **[D-1] Cache-Only Mode Uncaught Misses**
  - **Citation**: [src/agent/response-cache.ts:L62-L64](file:///c:/Users/meeta/OneDrive/Desktop/copperhead/src/agent/response-cache.ts#L62-L64)
  - **Details**: Added explicit check for `process.env.COPPERHEAD_CACHE_ONLY === '1'` inside `CachingProvider.chat()`. Throws a `CacheMissError` if a requested turn is not present in the local response cache directory.

- **[D-2] Premature ERC Check on Non-Existent Schematic**
  - **Citation**: [src/agent/tools.ts:L454-L457](file:///c:/Users/meeta/OneDrive/Desktop/copperhead/src/agent/tools.ts#L454-L457)
  - **Details**: Fixed `check_drift` handler to check `existsSync(path.join(ctx.repoRoot, ctx.config.schematic))` before invoking drift analysis, preventing initial doc stages (`spec-seed`, `architecture`, `part-selection`) from failing before the schematic file is scaffolded.

- **[D-3] Benign Symbol Mismatch Warnings Flagged as ERC Failures**
  - **Citation**: [src/kicad/report.ts:L66-L68](file:///c:/Users/meeta/OneDrive/Desktop/copperhead/src/kicad/report.ts#L66-L68)
  - **Details**: Filtered `lib_symbol_mismatch` warnings out of ERC/DRC report violations to prevent false-positive failures on KiCad 10+.

## INEFFICIENCY

- **[I-1] Infinite Oscillation in Repair Cycle Counting**
  - **Citation**: [src/agent/tools.ts:L323-L330](file:///c:/Users/meeta/OneDrive/Desktop/copperhead/src/agent/tools.ts#L323-L330) and [L384-L391](file:///c:/Users/meeta/OneDrive/Desktop/copperhead/src/agent/tools.ts#L384-L391)
  - **Details**: Updated repair cycle counter to track `minErcViolations` and `minDrcViolations` across turns instead of resetting on any temporary violation drop. Any violation count equal to or greater than the historical minimum increments the repair budget counter, preventing infinite `5 -> 3 -> 5 -> 3` loops.

## NOTE

- **[N-1] Deterministic 8-Stage E2E Replay Test Coverage**
  - **Citation**: [test/e2e/create-full-run.test.ts:L30-L75](file:///c:/Users/meeta/OneDrive/Desktop/copperhead/test/e2e/create-full-run.test.ts#L30-L75)
  - **Details**: The end-to-end replay harness runs all 8 pipeline stages (`spec-seed` through `devplan`) sequentially via `runCreate`, using `MOCK_GENERATOR` provider interception in `src/agent/loop.ts:L75-L158` to execute valid tool calls, ERC/DRC checks, and stage completion contracts without live API keys.
