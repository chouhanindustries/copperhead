# Proposal: escalate-stage-turn-budget

## Why

A `create` stage that fails with `turn-budget-exhausted` is retried with exactly the turn budget that just proved insufficient (GitHub issue #135). With the default `maxStageRetries: 2` the schematic stage can run three times at 40 turns, roll back three times, and end no closer than it started. The recovery supervisor cannot compensate: it sees the failure only as the prose string `the run ended as "failure" (turn-budget-exhausted)`, so it cannot tell turn starvation from a bad edit, and its verdicts are limited to `retry` and `abort`. Turn starvation is the one failure mode where an identical retry is knowably futile.

## What Changes

- A stage attempt that exits `turn-budget-exhausted` escalates the next attempt's budget by `ceil(previous / 2)`, the same increment the attended continue prompt already offers, so three attempts on the default budget run at 40, 60 and 90 turns. Every other exit path retries at the unchanged budget.
- The recovery supervisor is handed the failed attempt's `exitPath` as a structured line, plus the budget the next attempt has already been granted, so it stops guessing the cause from prose. Its verdict set is unchanged: escalation stays deterministic arithmetic in the pipeline, not a model call that fails safe to `abort`.
- When every attempt of a stage ran out of turns, the stage's final line says the stage needs a larger budget and names both places that set one.
- `copperhead create` gains `--max-turns <n>`, parsed by the same validator `do`, `sync` and `repl` use. Until now the only way to give a create stage a realistic budget was to hand-edit `stageMaxTurns` into `.copperhead/config.json` before the run.
- Built-in per-stage defaults (`schematic: 100`, `layout-draft: 80`) promote the numbers `manual-tests/setup.sh` has been setting for create sandboxes (with a comment saying 40 is inadequate) into the product default. Resolution order: `stageMaxTurns[stage]` > `--max-turns` > built-in default > global `maxTurns`.
- The attended budget-exhaustion prompt now gates on `stdin.isTTY` alone and asks on stderr when stdout is not a TTY, so a `| tee run.log` run keeps its escape hatch. No stdin TTY (CI) still means fail-and-restore.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `create-pipeline`: turn-budget escalation between stage attempts, the structured exit path handed to the recovery supervisor, and built-in per-stage turn defaults with a four-level resolution order.
- `cli-surface`: `create --max-turns <n>`; the attended budget-exhaustion prompt fires on a stdin TTY alone and asks on stderr when stdout is redirected.

## Impact

- `src/commands/create.ts`: `DEFAULT_STAGE_MAX_TURNS`, `resolveStageMaxTurns`, per-attempt budget escalation, the give-up remedy line, `CreateOptions.maxTurns`, and the resume command echoing the flag.
- `src/agent/recovery.ts`: `diagnoseStageFailure` accepts `exitPath` and `nextAttemptMaxTurns` and renders both as structured prompt lines.
- `src/util/cli-args.ts`: `confirmTty` gains output and input stream parameters; `budgetContinuePrompt` moves here (out of the argv-parsing entry point, so it is testable in process) and gates on stdin alone.
- `src/cli.ts`: `create --max-turns`, wired through the shared helpers.
- Tests: `test/create-budget-escalation.test.ts` (new), plus additions to `test/recovery.test.ts` and `test/cli-surface.test.ts`. No live-LLM tests required.
- Out of scope, tracked separately: per-stage token and wall budgets, edit-size caps, verify gating, checkpoint commits, turn-cost concentration metrics, and layout draft-quality scoring (issues #141 and #145).
