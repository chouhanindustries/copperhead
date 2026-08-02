# Tasks

## 1. Measurement primitives

- [x] 1.1 `src/agent/turn-metrics.ts`: `TurnSample`/`TurnCostSummary` types and `summarizeTurnCost` (nearest-rank `p50TurnOut`/`p95TurnOut`, `maxTurnOut`, `top5TurnShare`, `slowestTurnMs`); empty input zeroed, zero-output run 0% rather than `NaN`
- [x] 1.2 `src/agent/turn-metrics.ts`: `EditPressure`, `editPressureOf`, `EMPTY_EDIT_PRESSURE`, `addEditPressure` (folds a stage's attempts, keeping the largest single edit)
- [x] 1.3 `src/agent/turn-metrics.ts`: `readRunTurnCost(runDir)` scores an existing run directory from its `run-end` rows, preferring recorded edit pressure and falling back to reconstructing it from `tool` events
- [x] 1.4 `src/agent/transcript.ts`: `perTurn` becomes `TurnSample[]`; `RunStats` gains optional `turnCost`/`editPressure`; `summary.md` renders a turn-cost line and an edit-pressure line

## 2. Config

- [x] 2.1 `src/config.ts`: `maxEditBytes` (8192), `maxUnverifiedEdits` (1), `checkpointCommits` (true), each accepting `0`/`false` as "off" and clamping negatives to the default
- [x] 2.2 `src/config.ts`: `StageBudget` type and `stageBudgets` map, parsed through `normalizeStageBudgets` (non-positive and non-integer entries dropped)

## 3. Tool layer: the quantum

- [x] 3.1 `src/agent/tools.ts`: `RunContext` gains `unverifiedEdits` (per kind), `editsSinceCheckpoint` and `editCounts`; `freshEditCounters()` exported so every construction site starts zeroed
- [x] 3.2 `src/agent/tools.ts`: `markTouched` takes the payload size and maintains the counters; `edit_file`/`write_file` pass it on the accepted paths only (a reverted edit is not counted)
- [x] 3.3 `src/agent/tools.ts` `edit_file`: byte cap on KiCad files, refusing before anything is written, naming the cap, the attempted size, `maxEditBytes`, and the current symbol/footprint count
- [x] 3.4 `src/agent/tools.ts` `edit_file`: per-kind unverified-edit gate refusing with the check to run; `.kicad_pro`/`.kicad_sym`/`.kicad_mod` are capped but not gated
- [x] 3.5 `src/agent/tools.ts` `run_erc`/`run_drc`: reset the matching counter on pass AND fail, and count the verification

## 4. Loop: checkpoints and spend budgets

- [x] 4.1 `src/util/git.ts`: `commitPaths(repo, paths, message)` staging an explicit path list, skipping pathspecs that match nothing, returning null when nothing was staged
- [x] 4.2 `src/agent/loop.ts`: record `ms` per turn; thread `turnCost`/`editPressure` into `stats()` so every terminal branch reports them
- [x] 4.3 `src/agent/loop.ts`: `maybeCheckpoint(toolName)` after each dispatched tool call — clean check + edits since the last checkpoint + not a dry run + `checkpointCommits` — committing `ctx.filesTouched` with the `copperhead: checkpoint —` prefix, re-snapshotting, and logging; failures are warnings
- [x] 4.4 `src/agent/loop.ts`: `snap` becomes reassignable so the rollback target moves onto the checkpoint; `fail()` says so when checkpoints were taken
- [x] 4.5 `src/agent/transcript.ts`: `token-budget-exhausted` and `wall-budget-exhausted` exit paths
- [x] 4.6 `src/agent/loop.ts`: `RunOptions.budget`; `maxTokensOut`/`maxWallMs` checked at the top of each turn and failing on their own exit paths
- [x] 4.7 `src/agent/loop.ts`: `maxTurnOut` injects a split-the-unit user message (appended to the tool-less nudge when the turn made no calls) and continues; `turn-too-large` transcript event

## 5. Create pipeline

- [x] 5.1 `src/commands/stage-progress.ts`: `stageProgress()` for `schematic` (BOM refdes vs schematic symbols) and `layout-draft` (schematic symbols vs board footprints, both reference encodings); null for stages with no unit list; never throws
- [x] 5.2 `src/commands/create.ts`: append the progress line to the stage prompt, recomputed per attempt, and log its first sentence
- [x] 5.3 `src/commands/create.ts`: pass `config.stageBudgets[stage.name]` as the run's `budget`
- [x] 5.4 `src/commands/create.ts`: `StageCost` accumulates `perTurn` and folded `EditPressure` across attempts; `report.json` stage rows gain the five concentration figures plus `editBytesPerVerify`/`largestEditBytes`, `null` for resumed stages
- [x] 5.5 `src/commands/create.ts`: `REPORT.md` gains a `## Turn-cost concentration` table beside the cost table

## 6. Docs

- [x] 6.1 `src/memory/scaffold.ts`: `.copperhead/README.md` describes the four new config keys
- [x] 6.2 `docs/src/content/docs/reference/configuration.md`: the four new keys in the example and the table
- [x] 6.3 `openspec/specs/SPEC.md`: config example and prose, the two new exit paths, and the AC-16 block for this change

## 7. Tests (all offline)

- [x] 7.1 `test/turn-metrics.test.ts`: the issue's 40-value array reproduces p50 177 / max 43,629 / top-5 share 0.89; empty input zeroed; zero-output run not `NaN`; slowest turn from `ms`; edit-pressure arithmetic and folding
- [x] 7.2 `test/fixtures/runs/2026-07-29T18-02-20-554Z/transcript.jsonl` + `test/turn-metrics.test.ts`: a historical-style transcript (per-turn rows without `ms`) is scored by `readRunTurnCost`; a directory with no transcript returns null
- [x] 7.3 `test/quantize-stage-work.test.ts`: an oversized KiCad edit is refused with cap/size/setting/symbol count and the file is byte-identical; a 20 kB docs edit is accepted; `maxEditBytes: 0` disables
- [x] 7.4 `test/quantize-stage-work.test.ts`: a second unverified schematic edit is refused; `edit → run_erc → edit` passes; a FAILING `run_erc` still resets the counter and the repair edit lands; `maxUnverifiedEdits: 0` disables
- [x] 7.5 `test/quantize-stage-work.test.ts`: a checkpoint commit lands with the right prefix, survives a later failure, and does not sweep an unrelated dirty file; dry runs and `checkpointCommits: false` never checkpoint
- [x] 7.6 `test/quantize-stage-work.test.ts`: `token-budget-exhausted` and `wall-budget-exhausted` exit paths; the `maxTurnOut` nudge continues the run and reaches the model; `normalizeStageBudgets` drops junk
- [x] 7.7 `test/quantize-stage-work.test.ts`: `run-end` and `summary.md` carry `turnCost`/`editPressure` on a failing run; the progress line names the missing refdes for both stages
- [x] 7.8 `test/create-cost-report.test.ts`: `report.json` and `REPORT.md` carry the concentration columns, resumed stages report null, `stageBudgets` reaches the stage run, and the schematic prompt carries the progress line
- [x] 7.9 Existing `RunContext` constructions in `test/gating-sync.test.ts`, `test/create-hardening.test.ts`, `test/budget-efficiency.test.ts` adopt `freshEditCounters()`
- [x] 7.10 Full suite green: `npm run typecheck`, `npm run build`, `npm test`, `npm run lint:md`
