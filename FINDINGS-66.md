# Bounty #66 — End-to-end test: findings report

**Date**: 2026-07-29
**Scope**: `copperhead create` pipeline — mocked-provider end-to-end coverage

---

## Legend

| Tag | Meaning |
|---|---|
| **OBSERVATION** | Something worth noting — not necessarily a problem |
| **DEFECT** | A correctness bug in pipeline orchestration |
| **INEFFICIENCY** | A performance or ergonomic issue |
| **NOTE** | General observation |

## Findings

### F1. Stage 4 (schematic) completion contract is tested end-to-end

**Type**: OBSERVATION
**Where**: `test/create-e2e-pipeline.test.ts` — "stops when a stage receives a false-green ERC gate"
**Symptom**: The test injects a zero-symbol state (mocked `listSymbols` returning `[]`) while `runErc` reports `ok`. The pipeline correctly halts at stage 4/8, prints a resume point, and does not advance.
**Suggested**: No change needed. The existing completion contract (`listSymbols` + `checkDrift` + `runErc`) correctly gates the stage.
**Status**: Covered by test.

### F2. Pipeline resumes correctly after partial completion

**Type**: OBSERVATION
**Where**: `test/create-e2e-pipeline.test.ts` — "resumes past completed stages on a re-run"
**Symptom**: A first run completes spec-seed and commits it, then fails at architecture. A second run detects spec-seed as already complete via `isComplete`, skips it, and re-attempts architecture. The completed stages are logged as "resumed" and the stage cost table shows `—` for resumed stages.
**Suggested**: No change needed. Resume logic works correctly via the completion-contract design.
**Status**: Covered by test.

### F3. Agent failure does not hang the pipeline

**Type**: OBSERVATION
**Where**: `test/create-e2e-pipeline.test.ts` — "stops when the agent returns failure (wedged stage)"
**Symptom**: When `runAgentLoop` returns `outcome: 'failure'`, the pipeline logs the failure, consults the diagnosis (mocked), and stops with `ok: false`. No later stages are attempted.
**Suggested**: No change needed. The pipeline handles provider failures without hanging.
**Status**: Covered by test.

### F4. `bootstrapKicadProject` is pure file generation — testable without KiCad

**Type**: NOTE
**Where**: `src/kicad/bootstrap.ts`
**Symptom**: The function does not invoke `kicad-cli` — it generates well-formed s-expression KiCad files by string concatenation. This means it works in any environment (including CI without KiCad) and is safe to call during mocked tests.
**Suggested**: No change needed. This design is good for testability.
**Status**: No action required.

### F5. `runCheck` depends on kicad-cli for ERC/DRC

**Type**: NOTE
**Where**: `src/commands/check.ts`, `src/kicad/cli.ts`
**Symptom**: The post-pipeline `runCheck` call (`runCreate` line 826) shells out to `kicad-cli` for ERC and DRC verification. In the mocked test, this is bypassed by mocking the entire `check.ts` module. Real end-to-end testing requires KiCad to be installed.
**Suggested**: CI already installs KiCad (`.github/workflows/ci.yml` line 25), so this is not a problem. The mocked test covers orchestration; the live-integration tests in `agent-integration.test.ts` run ERC for real when a provider is configured.
**Status**: No action required.

### F6. Stage prompt guidance field must be presentable for diagnosis retry

**Type**: INEFFICIENCY
**Where**: `src/commands/create.ts:703-808`
**Symptom**: The auto-retry loop appends recovery guidance to the stage prompt on each retry. The mock test does not exercise the retry path because the mock always returns success on the first attempt.
**Suggested**: Add a follow-up test that simulates a first-attempt failure followed by a successful retry, verifying that guidance is appended to the stage prompt and the diagnosis call is made. This would validate that recovery tokens are accounted for in stage costs.
**Status**: Uncovered. Feature gap in the test suite.

### F7. VCR-style snapshot test would prevent orchestration regressions

**Type**: NOTE
**Where**: `test/create-e2e-pipeline.test.ts`
**Symptom**: The test asserts on `res.completed` and log line presence but does not capture a full snapshot of the pipeline's cost report JSON. A subtle change to the cost-accounting or stage-ordering logic would not be caught.
**Suggested**: Add a snapshot assertion on the `report.json` output to pin cost structure and stage metadata. This could be a follow-up PR once the initial report passes CI.
**Status**: Uncovered.

---

## Summary

| Item | Status |
|---|---|
| Full 8-stage completion | ✅ Tested |
| False-green ERC gate | ✅ Tested |
| Wedged stage (agent failure) | ✅ Tested |
| Resume past completed stages | ✅ Tested |
| Run report production | ✅ Tested |
| Retry + diagnosis coverage | ❌ Not tested (follow-up) |
| Report JSON snapshot | ❌ Not tested (follow-up) |

**4 findings** — all OBSERVATION/NOTE level, no BLOCKERs or DEFECTs in the pipeline orchestration layer.
