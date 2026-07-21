# Tasks — record-run-metadata

## 1. Model-selection source

- [x] 1.1 Change `resolveModel` in `src/config.ts` to return `{ model, source }` where source is `'flag' | 'env' | 'config' | 'openai-key' | 'anthropic-key'`; update its doc comment
- [x] 1.2 Update the three call sites in `src/cli.ts` (`do`, `sync`, `create`) to destructure the new shape and thread `source` toward the loop
- [x] 1.3 Extend the existing `resolveModel` unit tests to assert the winning source for each precedence level

## 2. Metadata collection module

- [x] 2.1 Create `src/agent/runmeta.ts` with the `RunMeta` type and `collectRunMeta(...)`: versions (copperhead version + install path via `import.meta.url`, kicad-cli passed through or probed, Node, platform), model/provider/source, run identity (run id, ISO timestamp, command, stage, interactive flag, brief path + sha256), resolved config snapshot with the effective `maxTurns`, git state (commit, branch, dirty + uncommitted count), pre-commit hook presence, open-constraint count, prior-run count
- [x] 2.2 Wrap every probe individually so a failure yields `null` for that field only; run probes concurrently with `Promise.all`
- [x] 2.3 Add read-only git helpers needed by the probes to `src/util/git.ts` (branch name, uncommitted-file count, hook presence) reusing existing execa patterns
- [x] 2.4 Write pure renderers `renderCliHeader(meta)` (≤2 lines) and `renderEnvironmentSection(meta)` (markdown `## Environment`) in the same module
- [x] 2.5 Unit-test `collectRunMeta` offline in a fixture repo: resolved-config snapshot (`--max-turns` override wins, `schematic: null` visible), probe-failure degradation to `null`, and both renderers' output

## 3. Wire metadata into the loop and callers

- [x] 3.1 Add the optional `meta` field to `RunOptions` (`command`, `modelSource`, `version`, `kicadCliVersion`, `stage?`, `brief?`); missing values render as `unknown`
- [x] 3.2 In `runWithMemory`, call `collectRunMeta` after `loadConfig`/preflight and before turn 1; emit the full object as the `run-start` event (keeping `request`, `model`, `provider` names), log the CLI header, and keep the object for the summary
- [x] 3.3 Pass `meta` from `src/cli.ts` for `do`, from `src/commands/create.ts` per stage (stage name, `index`/`total` from `STAGES`, brief path + sha256 of the content it already read), and from `src/commands/sync.ts` for the resolve phase
- [x] 3.4 Update existing loop/transcript tests for the enriched `run-start` shape

## 4. Post-run addenda and exit paths

- [x] 4.1 Add `exitPath` to `RunResult` and thread it through every terminal branch: `done`, `refused`, `turn-budget-exhausted`, `repair-cycles-exhausted`, `provider-error`, `stalled` (nudge exhaustion), `commit-failed`
- [x] 4.2 Wrap the final `commitAll` and archive-commit calls so a git failure routes through the rollback path with `exitPath: commit-failed` and the git error text in the summary detail — no unhandled throw
- [x] 4.3 Track per-turn token usage (`{turn, in, out}` from `res.usage`) and wall-clock duration from a start timestamp taken at collection time
- [x] 4.4 Emit a `run-end` event at every terminal branch with exit path, turns used vs budget, repair cycles used vs budget, token totals + per-turn rows, and duration
- [x] 4.5 Extend `RunSummaryData`/`writeSummary` in `src/agent/transcript.ts` to render `## Environment` and `## Run stats`; update `fail`, refusal, dry-run, and success branches to pass the new fields
- [x] 4.6 Offline tests: budget-exhaustion run reports `turn-budget-exhausted` with `turnsUsed == budget`; commit-failure run (fixture with an embedded repo or a stubbed `commitAll`) still writes `summary.md` with `commit-failed`

## 5. Live CLI output: progress renderer

- [x] 5.1 Create `src/agent/render.ts` with a `ProgressRenderer` implementing the loop's `log` seam plus `turnStart`/`toolResult`/`status`/`finish`; mode chosen once at startup from `process.stdout.isTTY`, `--json`, and `--plain`
- [x] 5.2 Plain mode: prefix each turn's output with `[turn k/N · <in>k in / <out>k out]` using cumulative token totals (compact formatting: `12.3k`, plain integers below 1000); keep tool-result lines one line each; zero ANSI escape codes
- [x] 5.3 Interactive mode: bottom-pinned status line redrawn in place (braille spinner while a provider call is in flight, elapsed time, turn counter vs budget, cumulative tokens); assistant text and tool results print above it via clear → print → redraw; hand-rolled ANSI, no new dependencies
- [x] 5.4 Terminal hygiene: hide cursor on start, restore cursor and clear the status line on finish, `exit`, and SIGINT
- [x] 5.5 Print a final outcome line at every terminal branch (replacing the status line in interactive mode): exit path, verification status, commit hash when present, duration, token totals
- [x] 5.6 Add a global `--plain` option in `src/cli.ts` (alongside `--json`) that forces plain mode; wire the renderer into `do`, `create`, and the `sync` resolve phase as the `log` implementation; existing programmatic callers keep passing a bare function
- [x] 5.7 Tests over a scripted fake provider: plain-mode snapshot (header, turn markers, outcome line, no ANSI escapes when not a TTY) and interactive-mode unit tests against a fake TTY writable (status-line redraw, cursor restore on finish)

## 6. Redaction and verification

- [x] 6.1 Test that a planted `sk-...` value in a metadata field is redacted in both the persisted `run-start` event and `summary.md`
- [x] 6.2 Run the full offline suite (`npm test`), `npm run build`, and `openspec validate record-run-metadata`; fix fallout
