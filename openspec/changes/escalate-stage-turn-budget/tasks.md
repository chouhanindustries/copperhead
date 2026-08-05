# Tasks

## 1. Budget resolution

- [x] 1.1 `src/commands/create.ts`: export `DEFAULT_STAGE_MAX_TURNS = { schematic: 100, 'layout-draft': 80 }`
- [x] 1.2 `src/commands/create.ts`: export `resolveStageMaxTurns(stage, config, flagMaxTurns?)` implementing `stageMaxTurns[stage]` > `--max-turns` > built-in default > `config.maxTurns`
- [x] 1.3 `src/commands/create.ts`: add optional `CreateOptions.maxTurns`; resolve the stage budget through the new helper and always pass it to `runAgentLoop`
- [x] 1.4 `src/commands/create.ts`: echo `--max-turns` in the printed resume command when the run carried one

## 2. Escalation

- [x] 2.1 `src/commands/create.ts`: track the attempt budget across the per-attempt loop; when the failed attempt's `exitPath` is `turn-budget-exhausted`, raise the next attempt's budget by `budgetExtraTurns({ maxTurns: previous })`
- [x] 2.2 `src/commands/create.ts`: log the raise on its own stage line (`previous → next`)
- [x] 2.3 `src/commands/create.ts`: when every attempt exited `turn-budget-exhausted`, print a final line naming the last budget, `--max-turns` and `stageMaxTurns` (on both the retries-exhausted and supervisor-abort paths)

## 3. Structured failure signal

- [x] 3.1 `src/agent/recovery.ts`: `diagnoseStageFailure` accepts optional `exitPath` and `nextAttemptMaxTurns`; renders `exitPath: <value>` and, when escalating, the granted next budget with "budget alone is not a reason to abort"
- [x] 3.2 `src/commands/create.ts`: thread the failed attempt's `exitPath` and any scheduled next budget through `diagnose(...)`
- [x] 3.3 Verdict set unchanged (`retry` / `abort`): no new verdict, escalation stays deterministic

## 4. CLI surface

- [x] 4.1 `src/util/cli-args.ts`: move `confirmTty` here and give it output/input stream parameters
- [x] 4.2 `src/util/cli-args.ts`: move `budgetContinuePrompt` here, gate on `stdin.isTTY` alone, ask on stderr when stdout is not a TTY, streams injectable via `PromptIo`
- [x] 4.3 `src/cli.ts`: import both from `cli-args`; add `--max-turns <n>` to `create`, parsed with `parseMaxTurns` before any provider or kicad-cli work, threaded as `CreateOptions.maxTurns`

## 5. Tests (all offline)

- [x] 5.1 `test/create-budget-escalation.test.ts`: 40 → 60 → 90 across three turn-starved attempts; each raise logged
- [x] 5.2 `test/create-budget-escalation.test.ts`: a non-budget exit path retries at the unchanged budget and logs no raise
- [x] 5.3 `test/create-budget-escalation.test.ts`: the give-up line names the last budget, `--max-turns` and `stageMaxTurns`, and stays absent for non-budget failures
- [x] 5.4 `test/create-budget-escalation.test.ts`: `exitPath` and `nextAttemptMaxTurns` reach the supervisor; the latter is omitted with no escalation
- [x] 5.5 `test/create-budget-escalation.test.ts`: full precedence chain, including config `stageMaxTurns` beating `--max-turns`, and the schematic stage getting its built-in 100 through a real run
- [x] 5.6 `test/recovery.test.ts`: the supervisor prompt contains `exitPath: turn-budget-exhausted` and the next budget; both lines absent when not supplied
- [x] 5.7 `test/cli-surface.test.ts`: `budgetContinuePrompt` returned with a stdin TTY and a non-TTY stdout, question on stderr; on stdout when both are TTYs; undefined with no stdin TTY
- [x] 5.8 `test/cli-surface.test.ts`: `create --help` advertises `--max-turns` and a bad value refuses to start
- [x] 5.9 `test/create-stage-turns.test.ts`: updated for the explicitly resolved global budget
- [x] 5.10 Full suite green: `npm run typecheck`, `npm run build`, `npm test`, `npm run lint:md`

## 6. Spec coherence

- [x] 6.1 `openspec/specs/SPEC.md`: `create --max-turns` in the CLI surface, the budget precedence chain in the config section, and AC-16 for this change
- [x] 6.2 `openspec validate escalate-stage-turn-budget` passes
