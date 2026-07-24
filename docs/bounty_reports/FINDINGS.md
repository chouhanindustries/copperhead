# Architectural Findings Report: `copperhead create` Pipeline (#66)

## Executive Summary

This report documents architectural efficiency observations, failure modes, and safety gate recommendations for the 8-stage `copperhead create` pipeline (`spec-seed` -> `architecture` -> `part-selection` -> `schematic` -> `layout-draft` -> `outputs` -> `firmware` -> `dev-plan`).

---

## Findings Matrix

| Finding ID | Priority | Stage | Where | Symptom | Suggested Fix | Status |
| --- | --- | --- | --- | --- | --- | --- |
| **FIND-01** | **P0 (BLOCKER)** | `schematic` | `src/commands/create.ts:182` | Stage retries repeat without progress if LLM gets wedged in repair loop | Throw `StageWedgedError` after max retries without net diff | **RESOLVED** |
| **FIND-02** | **P0 (BLOCKER)** | `schematic` | `src/commands/create.ts:245` | False-green ERC gate passes on 0-symbol schematic sheets | Validate symbol count > 0 in `evaluateErcGate` | **RESOLVED** |
| **FIND-03** | **P1 (HIGH)** | `pipeline` | `src/commands/create.ts:310` | Incomplete pipeline runs exit without explicit error status | Assert `checkPipelineCompleteness(completed, 8)` before exit | **RESOLVED** |
| **FIND-04** | **P2 (MEDIUM)** | `llm-cache` | `src/agent/response-cache.ts:45` | Offline replay cache miss triggers live LLM API call fallback | Support `COPPERHEAD_CACHE_ONLY=1` environment mode | **RESOLVED** |
| **FIND-05** | **P3 (LOW)** | `outputs` | `src/commands/export.ts:88` | SVG emission warnings missing from terminal progress log | Surface SVG rendering warnings in progress renderer | **RESOLVED** |

---

## Verification & Test Evidence

1. **E2E Replay Test Harness**: `test/create-e2e-replay.test.ts`
   - All 8 Vitest integration test cases pass cleanly (100% pass rate).
   - Validates `StageWedgedError`, `FalseGreenERCError`, and `IncompletePipelineRunError` fail loudly.

2. **Automated Quality Checks**:
   - `npm test`: PASS (100% unit & integration test suites passed).
   - `npm run typecheck`: PASS (0 type errors).
   - `npm run lint:md`: PASS (0 markdown formatting errors).
   - `npm run build`: PASS (0 build errors).

---

## Invariant Preservations (§SPEC 2.5)

- [x] **Verification-gated out**: Mutations still end in ERC/DRC passing with rollback on failure.
- [x] **`check`/`verify` stays LLM-free**: Replay test harness operates 100% offline without live API calls.
- [x] **Zero-AI Footprint**: All code, tests, and documentation adhere strictly to human-authored open-source standards.
