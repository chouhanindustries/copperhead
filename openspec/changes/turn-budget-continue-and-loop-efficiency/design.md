# Design: turn-budget-continue-and-loop-efficiency

## Context

Issue #15's trace analysis (`.copperhead/runs/2026-07-21T10-44-49-392Z/`) showed a spec-seed `create` stage that needed ~60 turns to finish cleanly under the current mechanics, against a 40-turn budget. Three compounding causes: the model emitted exactly one tool call per assistant message (nothing in the prompt says batching is possible), 27 of 34 `affects-revisit` obligations targeted a schematic/layout/BOM that did not exist yet, and `finish` was refused with the backlog still open, so the run drained its remaining turns on one-per-turn "no change needed" resolutions. When the budget ran out, `fail()` hard-restored the snapshot and destroyed the work. Separately, the Anthropic provider sends no `cache_control`, so Claude runs pay full input price on the quadratic re-sent conversation.

Current mechanics involved: the turn loop and `fail()` in `src/agent/loop.ts`, the obligations ledger in `src/agent/ledger.ts`, tool handlers in `src/agent/tools.ts`, the WORKFLOW prompt in `src/agent/prompts.ts`, snapshot/restore in `src/util/git.ts`, and the `--interactive` confirm plumbing in `src/cli.ts`.

## Goals / Non-Goals

**Goals:**

- Turn exhaustion in an attended run becomes a user decision with cost visibility, not an unconditional rollback.
- No failure path destroys work: anything touched is recoverable from a stash entry.
- The spec-seed stage (and stages like it) fits comfortably inside the default 40-turn budget through batching guidance, obligation deferral, and array resolution.
- Claude runs get prompt caching without changing the provider interface.

**Non-Goals:**

- No conversation-compaction or context-window management (separate concern).
- No persistence of deferred obligations across runs: cross-run reconciliation stays with `check`/`sync` drift detection and the constraint registry's `affects[]`, which already survives the run.
- No change to the OpenAI provider (prefix caching is automatic there).
- No interactive mid-run steering beyond the continue prompt.

## Decisions

### D1: Continue prompt as an injected callback, not TTY logic in the loop

`RunOptions` gains `onBudgetExhausted?: (stats) => Promise<number>`: it receives `{maxTurns, turnsUsed, tokensIn, tokensOut, filesTouched, openObligations}` (`maxTurns` is the original budget, so the CLI can offer a constant increment across repeat extensions) and returns the number of extra turns (0 means fail as today). A callback that throws (stdin closed mid-prompt) is treated as declining, so the preserve-and-restore path still runs. The CLI wires it to a readline prompt only when stdin and stdout are TTYs; `create` passes the same wiring per stage. The loop stays testable with a fake callback and CI behavior is unchanged by construction (no TTY, no callback firing).

The prompt offers `ceil(maxTurns / 2)` extra turns and shows token usage in thousands (`247.3k in / 9.5k out`). The callback can fire again at the next exhaustion; each extension is a fresh decision with fresh numbers. Alternative considered: a `--continue-turns` flag that pre-authorizes extensions, rejected because the whole point is a human decision at the moment the cost is known.

### D2: Preserve failed work with `git add -A` + `git stash create` + `git stash store`

`git stash create` alone ignores untracked files, and most of what a docs-stage run produces is new files. Staging everything first brings untracked files into the stash object, and `restore()` already does `reset --hard` so the mutated index does not matter. `git stash store -m "copperhead failed run <run-id>"` makes it visible in `git stash list` without touching HEAD or branches. Runs in `fail()` before `restore()` whenever the tree is dirty relative to the snapshot; a no-op on clean trees. Alternative considered: a `copperhead/failed/<run-id>` branch, rejected because it needs a commit identity, pollutes branch listings, and stash entries are the established "recoverable but out of the way" idiom.

### D3: Defer, not skip, revisit obligations for nonexistent artifacts

In the `record_constraint` handler, each `affects` item is classified: schematic-ish (`schematic`, `*.kicad_sch`) requires `config.schematic`, board-ish (`layout`, `board`, `pcb`, `*.kicad_pcb`) requires `config.board`, doc-ish (`*.md`, or a basename matching a file in the docs dir) requires the doc file to exist. Positively classified items whose artifact is missing become deferred entries in the ledger (a separate list that never blocks `finish`); everything else opens a normal obligation. Deferred items are named in the tool result and in `summary.md`, so the reconciliation duty stays visible: the constraint registry keeps the full `affects[]` regardless, and future stages that create the artifact re-encounter the constraint through the system prompt's registry dump. Alternative considered: silently skipping, rejected because an invisible dropped obligation breaks the ledger's audit story.

### D4: Anthropic prompt caching via three `cache_control` breakpoints

The provider marks `{type: 'ephemeral'}` on: the system prompt (converted to a block array), the last tool definition, and the last content block of the final message. That caches the stable prefix (system + tools) and the growing conversation up to the previous turn. Cache accounting: `usage.input_tokens` excludes cached tokens in the Anthropic API, so `tokensIn` sums `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` to keep the summary's token line honest about volume, while the cost benefit shows up at billing. No provider-interface change.

### D5: `resolve_affected` array form is additive

The schema gains an optional `resolutions: [{constraint_key, item, resolution}]`; the three single-form properties stop being schema-required (JSON Schema cannot express either-or cleanly across providers) and the handler validates: array present wins, else single form, else a corrective error listing both shapes. Each array entry is resolved independently and reported per-item, so one bad key does not waste the whole call.

### D6: Per-stage budgets via `stageMaxTurns` config

`.copperhead/config.json` gains optional `stageMaxTurns: Record<string, number>` keyed by pipeline stage name. `create` passes `stageMaxTurns[stage.name]` as the run's `maxTurns` when present; otherwise the global default applies. Stage names not in the map are unaffected; unknown keys are ignored. Rejected alternative: hardcoded per-stage defaults in `STAGES`, rejected because the right budget depends on the design's size, not just the stage kind.

## Risks / Trade-offs

- [Deferral heuristic misclassifies an affects item] → It only defers on a positive match against a missing artifact; ambiguous items (refdes, nets, free text) always open real obligations, and every deferral is named in the tool result and summary.
- [Stash entries accumulate across repeated failures] → Each failure logs the exact stash ref and a `git stash drop` hint; entries are cheap and manually reapable.
- [Extended runs can extend repeatedly and burn tokens] → Every extension re-prompts with cumulative token usage; the default answer is No.
- [`cache_control` on very small payloads adds cache-write cost] → Cache writes cost 25% extra once but reads save 90% every following turn; with a 40-turn conversation the break-even is the second turn.
- [Staging everything for the preservation stash includes junk files] → The stash is only created on failure paths and `.gitignore` (which excludes `.env` and `.copperhead/runs/`) is respected by `git add -A`.

## Open Questions

(none: all decisions above are settled for this change)
