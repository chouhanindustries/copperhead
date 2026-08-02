# Proposal: quantize-stage-work

## Why

Across 14 runs in this repo, 112 minutes of wall time produced a schematic and no
board, and the spend was not spread across the pipeline. In the 65m46s schematic
run, 5 of 40 turns emitted 89% of the run's 170,920 output tokens (median turn:
177; largest: 43,629), and every observed failure mode landed on an oversized
turn: `provider-error` mid-response, `turn-budget-exhausted`, and a 10-minute
single-turn stall that cleared the 600 s watchdog with 18 seconds to spare
(GitHub issue #145).

Two things are wrong, and they compound.

**The concentration is invisible.** `REPORT.md` reports one wall/turn/token
figure per stage, so a stage with one 43k-token turn and a stage with forty even
ones look identical. `top5TurnShare` would have read 0.89 at turn five; the wall
total only read at minute 66.

**The quantum is a suggestion.** The stage-4 prompt says "work ONE part at a
time"; the measured run made 51 `edit_file` calls against 6 `run_erc` calls, with
a single 17,884-character block among them. An instruction with no mechanism
behind it loses to the model's preference for batching, and when a grid slip
lands inside a 17.9 kB block, the repair is a full-block rewrite, which is
another giant turn. Nothing commits until the stage ends, so a mid-response
provider error costs the whole stage rather than one part.

## What Changes

- **Measure the concentration.** A pure `summarizeTurnCost` over the per-turn
  rows the loop already records gives `p50TurnOut`, `p95TurnOut`, `maxTurnOut`,
  `top5TurnShare` and `slowestTurnMs`. The loop now records wall time per turn
  and counts edits, edited bytes, largest edit and verifications at the tool
  layer. Both land in the `run-end` event, in `summary.md`, and per stage in
  `report.json` / `REPORT.md`. The same function scores an existing run
  directory, so the runs recorded before this change can be replayed.
- **Cap the emission per edit.** `edit_file` refuses a `new_string` over
  `maxEditBytes` (default 8192) on KiCad files, naming the cap, the attempted
  size, the setting, and the current symbol/footprint count, and writing nothing.
  Docs are deliberately not capped.
- **Gate progression on verification.** Unverified KiCad edits are counted per
  file kind; `run_erc` resets the schematic counter and `run_drc` the board
  counter, pass or fail. Past `maxUnverifiedEdits` (default 1) the next edit to
  that kind is refused with the check to run. `edit → run_erc → edit` batched in
  one reply passes; `edit → edit` does not.
- **Commit per verified unit.** A clean ERC/DRC after at least one edit commits
  only the paths this run touched, with a message prefixed
  `copperhead: checkpoint —`, and re-snapshots so the rollback target moves onto
  it. A provider error then costs one unit, not a stage. Never on a dry run,
  never with `checkpointCommits: false`, and never sweeping paths the run did not
  touch (every create stage runs with `--allow-dirty`).
- **Budget in the right unit.** `stageBudgets` in config gives each stage
  `maxTokensOut` / `maxWallMs` / `maxTurnOut`. The first two end the run on the
  new `token-budget-exhausted` / `wall-budget-exhausted` exit paths; exceeding
  `maxTurnOut` means the unit was too big, so it injects a split-the-unit message
  and the run continues.
- **Tell a resumed stage where it is.** A computed progress line ("18 of 32 BOM
  parts present in the schematic; missing: …") is appended to the schematic and
  layout-draft prompts, recomputed before every attempt.

## Out of scope (deferred, with reason)

Issue #145 also asks for `schematic` and `layout-draft` to be **decomposed into
gated sub-stages** (`symbols` → `connectivity` → `annotation`; `import` →
`placement` → `route-power` → `route-signal` → `document`). That is deferred.

A sub-stage is only real if its completion contract can be evaluated
deterministically, and the contracts available today cannot tell "symbols placed"
from "symbols wired": both states have symbols, both can be drift-clean, and both
can pass ERC on a sheet whose pins are flagged no-connect. Splitting on a
contract that cannot distinguish the two produces stages that report complete
while the work they name has not happened, which is the exact failure the
content-aware completion contracts were added to stop. The routing sub-stages
have the same problem from the other side: "routed" needs the connectivity model
that issue #141 is building, and shipping a second, weaker one here would leave
two disagreeing definitions in the tree.

What motivated the split was resumability, and checkpoint commits plus the
computed progress line deliver that at finer granularity than a sub-stage would:
work is committed per verified unit rather than per sub-stage, and a resumed
stage is told which units remain by name. The decomposition can land later on top
of a deterministic per-unit contract without redoing any of this.

Also out of scope, because they belong to sibling issues: turn-budget escalation
on retry and `create --max-turns` (#135), and anything that scores layout quality
(#141).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `agent-core`: `edit_file` gains a KiCad-only byte cap and a per-kind unverified-edit
  gate; the loop checkpoint-commits verified units and moves its rollback target;
  output and wall budgets end a run on their own exit paths; an oversized turn is
  nudged to split rather than aborted; per-turn wall time and run-wide edit
  pressure are recorded.
- `run-observability`: turn-cost concentration is computed from per-turn rows,
  reported on every terminal path, and derivable from a historical run directory.
- `create-pipeline`: `stageBudgets` per stage; computed stage-progress lines; the
  per-stage cost summary gains concentration and edit-pressure columns.

## Impact

- `src/agent/turn-metrics.ts` (new): `summarizeTurnCost`, edit-pressure helpers,
  `readRunTurnCost`.
- `src/commands/stage-progress.ts` (new): computed per-stage unit progress.
- `src/agent/tools.ts`: the two `edit_file` gates, the counters on `RunContext`,
  counter resets in `run_erc`/`run_drc`.
- `src/agent/loop.ts`: per-turn `ms`, checkpoint commits and the moving snapshot,
  spend budgets and their exit paths, the split-the-unit nudge, stats plumbing.
- `src/agent/transcript.ts`: two new exit paths; `turnCost`/`editPressure` on
  `RunStats` and in `summary.md`.
- `src/commands/create.ts`: stage budgets, progress line, report columns and the
  concentration table.
- `src/config.ts`: `maxEditBytes`, `maxUnverifiedEdits`, `checkpointCommits`,
  `stageBudgets` with a validator.
- `src/util/git.ts`: `commitPaths` (subset commit).
- Docs: `.copperhead/README.md` scaffold and the configuration reference.
- Tests: `test/turn-metrics.test.ts`, `test/quantize-stage-work.test.ts`,
  `test/create-cost-report.test.ts`; a historical transcript fixture under
  `test/fixtures/runs/`. No live-LLM tests required.
