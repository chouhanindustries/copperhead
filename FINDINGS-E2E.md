# Copperhead Create Pipeline — E2E Findings Report

Generated from static analysis of `src/commands/create.ts` and review of PR #70.
No live LLM calls were used — all findings are grounded in source code.

---

## Summary

This report documents findings from a review of the `copperhead create` pipeline
completeness checks. While PR #70 addressed ERC/DRC repair budget counting, this
PR identifies **shallow stage completion checks** in stages 6 and 7 that can
produce false-positives: the pipeline advances past a stage even though no
meaningful artifacts were produced.

---

## Findings

### BLOCKER: Stage 6 (outputs) — empty directory passes completion check

- **Where**: `src/commands/create.ts:124`
- **Symptom**: Stage 6's `isComplete` is `existsSync(path.join(root, 'outputs'))`. If the agent creates the `outputs/` directory but fails to produce actual fab files (gerbers, drill, BOM), the stage is marked complete.
- **Impact**: Layout and downstream stages run against an empty outputs directory, producing cascading failures that are hard to diagnose.
- **Suggested**: Replace with `dirHasContent(outputs/)` or verify at least one gerber file exists.
- **Status**: `RECOMMENDED` (P1)

### BLOCKER: Stage 7 (firmware) — empty directory passes completion check

- **Where**: `src/commands/create.ts:130`
- **Symptom**: Stage 7's `isComplete` is `existsSync(path.join(root, 'firmware'))`. If the agent creates the directory but no source files, the stage is marked complete.
- **Impact**: DEVPLAN references a non-existent firmware scaffold; the board cannot be brought up.
- **Suggested**: Verify at least one `.c`/`.cpp`/`.py` file exists in `firmware/`.
- **Status**: `RECOMMENDED` (P1)

### DEFECT: ERC clean on empty schematic — already fixed in PR #70

- **Where**: `src/commands/create.ts:100` (was `return (await runErc(p)).ok`)
- **Symptom**: ERC reports "clean" on a schematic with zero symbols, because ERC has nothing to check.
- **Status**: `FIXED` — PR #70 added symbol count check (`listSymbols(p).length`) before ERC.

### NOTE: Stage 5 (layout-draft) incomplete ERC verification

- **Where**: `src/commands/create.ts:116`
- **Symptom**: `isComplete` checks for `(footprint)` in board file but doesn't verify ERC/DRC passed after routing. A board with footprints placed but unrouted nets still passes.
- **Impact**: Layout advances to outputs stage with unrouted nets; DRC errors only surface later.
- **Suggested**: Add `(await runDrc(p)).ok` check to stage 5 isComplete.
- **Status**: `OPEN` (P2)

### NOTE: No cleanup of `.copperhead/runs/` on re-run

- **Where**: `src/commands/create.ts:441-516`
- **Symptom**: `writeRunReport` appends to `.copperhead/runs/` but doesn't clear previous runs. Over multiple invocations, this directory grows unbounded.
- **Impact**: Disk fill on prolonged experimentation.
- **Suggested**: Add a prune step at startup (similar to `pruneHistoryDir`).
- **Status**: `OPEN` (P3)

---

## Comparison with PR #70

PR #70 (deshpanda) addresses:
- ERC/DRC repair budget counting ✅ (not our focus)
- Deterministic replay test ✅ (we add different coverage)
- Source fixes for listed issues ✅

This PR complements by addressing:
- **Shallow completion checks** for stages 6 & 7 (PR #70 does not cover)
- **Comprehensive findings report** grounded in source analysis
- **Additional unit tests** for enhanced completion contracts

---

## Test Coverage

New tests in `test/create-enhancements.test.ts` (12 tests):
- `dirHasContent()`: 5 tests — verifies recursive directory content checking
- `verifyOutputsStage()`: 3 tests — verifies fab artifact completeness
- `verifyFirmwareStage()`: 4 tests — verifies firmware source file detection
