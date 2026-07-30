# Design: escalate-stage-turn-budget

## Context

`runCreate` (`src/commands/create.ts`) reads the stage's turn budget once per stage, outside the attempt loop, and hands the same number to every attempt. `runAgentLoop` (`src/agent/loop.ts`) already records how a run ended as a machine-readable `exitPath` on `RunResult`, and `RunOptions.maxTurns` already accepts a per-run budget, so nothing new has to be measured: the failure is that the pipeline never reads the field it is already given.

The attended escape hatch from issue #15 lives in `budgetContinuePrompt()` in `src/cli.ts`, which offers `budgetExtraTurns` (`ceil(originalBudget / 2)`) more turns when the budget runs out.

Inherited constraints from SPEC.md that shape the decisions below:

- Verification-gated out: no mutation is done until ERC (and DRC if the board changed) passes; a failed stage attempt rolls the tree back to the snapshot. A retry that walls at the same place therefore costs a full rollback, not just tokens.
- `check` stays LLM-free and network-free; nothing here touches its module graph.
- Recovery must fail safe toward reporting to the human rather than looping (`diagnoseStageFailure` resolves any error or ambiguity to `abort`).

## Goals / Non-Goals

**Goals**

- A stage that dies of turn starvation is never retried at the same budget.
- The one failure mode whose remedy is arithmetic is decided by arithmetic, not by a model call.
- A create run can be given a realistic budget from the command line, without a config round trip.
- A piped or redirected run keeps the attended escape hatch.

**Non-Goals**

- Per-stage token or wall-clock budgets, edit-size caps, verify gating between edits, checkpoint commits, and turn-cost concentration metrics: separate changes (issues #141, #145).
- Anything about layout quality.
- Changing what a non-attended run does on exhaustion. With no stdin TTY it still fails and restores.
- Automatic budget tuning from historical runs. The numbers here are defaults, not a model.

## Decisions

### D1: Escalate on the exit path, not on the supervisor's opinion

`turn-budget-exhausted` is already a machine-readable field on `RunResult`, so the escalation is deterministic in `runCreate`: remember the previous attempt's `exitPath`, and when it was `turn-budget-exhausted` give the next attempt `previous + budgetExtraTurns({ maxTurns: previous })` turns. That reuses the increment the attended prompt already offers, so an attended and an unattended run escalate identically, and it produces 40 → 60 → 90 across the three attempts the default `maxStageRetries: 2` allows.

The supervisor still runs, but it is now told the structured cause and the escalation that is already scheduled. Rejected alternative: a third verdict (`retry-with-more-turns`). It puts a deterministic arithmetic decision behind a model call that fails safe to `abort`, which is exactly the failure the issue describes: a stage dying for want of turns and a supervisor with no way to say so.

The escalation is announced on its own stage line (`raising the next attempt's budget 40 → 60`) rather than folded into the existing failure line, because the raise is a decision the pipeline made, not a description of what went wrong, and an operator scanning a long log needs to see it as an event.

### D2: Turn-budget resolution has four levels, and config still wins per stage

`stageMaxTurns[stage]` (config) > `--max-turns` (flag) > `DEFAULT_STAGE_MAX_TURNS[stage]` (built-in) > `maxTurns` (config/global). The flag sits *under* the per-stage config entry because issue #135 defines it as "the per-stage cap that `stageMaxTurns` still overrides per stage": a user who has tuned one stage in config should not lose that tuning by passing a global flag. This inverts the usual flag-beats-config direction, so it is spelled out in the flag's own help text.

`DEFAULT_STAGE_MAX_TURNS` is `{ schematic: 100, 'layout-draft': 80 }`, the numbers `manual-tests/setup.sh` already uses, promoted from a test-only workaround into the product default: the repo has documented 40 as inadequate for those stages for months, and only sandbox repos were getting the fix.

The resolver returns a concrete number for every stage rather than `undefined` for "let the loop decide". Escalation needs a budget to escalate *from*, and a stage whose budget is only implicit cannot report the one it ran under. The visible consequence is that `create` now always passes `maxTurns` to `runAgentLoop`; the value for an untuned stage is the same `config.maxTurns` the loop would have defaulted to.

### D3: The continue prompt needs a TTY to *ask on*, not a TTY to *print to*

`budgetContinuePrompt()` required both `stdin.isTTY` and `stdout.isTTY`. Only the first is load-bearing: with stdin attached, the question can be asked on stderr, which `> file` and `| tee` leave alone. So the gate becomes `stdin.isTTY` alone and the readline interface writes to stderr whenever stdout is not a TTY. Fully unattended runs (no stdin TTY, i.e. CI) keep fail-and-restore unchanged, by construction rather than by convention: no TTY, no callback, and the loop's existing no-callback path runs.

`confirmTty` and `budgetContinuePrompt` move from `src/cli.ts` to `src/util/cli-args.ts`. `cli.ts` parses argv at import time, so importing it to test a branch runs the program; `cli-args.ts` exists precisely for the CLI logic that has a branch worth pinning. `budgetContinuePrompt` takes its three streams as a parameter defaulting to `process`, which is what lets the piped case be driven with real `PassThrough` streams in a unit test rather than asserted from the outside.

## Risks / Trade-offs

- **A raised budget is a raised bill.** Three escalating attempts at 40/60/90 turns cost more than three at 40 before the pipeline gives up. That is the intended trade (the alternative is three guaranteed-futile attempts), and the give-up line now names the remedy so the operator does not spend the next run rediscovering it. `maxStageRetries: 0` still disables retries entirely.
- **Raising the built-in defaults changes what an existing repo does.** A repo with no `stageMaxTurns` gets 100 turns for `schematic` where it got 40, so a stage that used to wall at 40 may now run more than twice as long before failing. Explicit config and the new flag both override it.
- **Escalating from the previous budget compounds.** Each raise is half again the last, so a hypothetical fourth attempt would ask for 135. With `maxStageRetries` defaulting to 2 there is no fourth attempt; a user who raises the retry count is choosing that growth.
- **stderr now carries an interactive question.** A run whose stderr is also redirected loses the prompt again, and a run that redirects stderr while watching stdout will see the answer echoed nowhere. Both are strictly better than today's behaviour, where any stdout redirection removed the prompt.
