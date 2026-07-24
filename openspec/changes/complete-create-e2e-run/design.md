# complete-create-e2e-run: Design

## Context

`markTouched` intentionally clears `lastErc` or `lastDrc` after a KiCad edit, because a previous clean result no longer verifies the current artifact. That makes those fields unsuitable for measuring convergence between checks. The old counter avoided this problem by incrementing on every failure, but it also exhausted during healthy incremental construction.

## Decisions

- **D1: Retain a small per-check progress record.** `repairProgress` stores the previous violation count and current non-improving streak independently for ERC and DRC. It survives KiCad edits while `lastErc` and `lastDrc` keep their verification-gate semantics.
- **D2: Lower counts reset the streak.** The first failure establishes a baseline with streak zero. A lower count proves progress and resets to zero. Equal or higher counts increment the streak. A clean report removes that check kind's progress record.
- **D3: Preserve one bounded run-level statistic.** `repairCycles` remains the high-water mark of either check kind's non-improving streak, so existing transcript and exhaustion fields remain compatible. The loop still rolls back only when the value is greater than `maxRepairCycles`.

## Risks / Trade-offs

- [Violation count falls while severity worsens] -> The final clean gate remains mandatory, and a later equal/higher count still advances the bounded streak. Severity weighting would add policy not present in KiCad's normalized report contract.
- [Alternating ERC and DRC can each consume work] -> The trackers are independent because schematic and board convergence are separate artifacts; either one's high-water mark can still exhaust the run.
