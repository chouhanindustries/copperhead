# Tasks — flush-run-metrics-incrementally

## 1. Real cache-hit signal

- [x] 1.1 Add `cacheHit?: boolean` to `Turn` in `src/agent/types.ts`
- [x] 1.2 `CachingProvider.chat()` in `src/agent/response-cache.ts` sets `cacheHit: true` on the hit path alongside the existing zero-usage override; miss path returns the inner `Turn` unchanged

## 2. Live metrics module

- [x] 2.1 Create `src/agent/metrics.ts`: `LiveMetrics` type (`status: 'running' | 'stalled' | ExitPath`, run id, turn/maxTurns, token totals, cache hits, `startedAt`/`lastUpdateAt`) — a distinct type from `RunStats`/`ExitPath`, not a reuse
- [x] 2.2 `writeLiveMetrics(dir, data)`: atomic write (temp file + `rename`) with an `fsync` before rename; temp filename includes a per-write monotonic counter, not just `process.pid`, so two writers racing in the same process (heartbeat vs. per-call vs. the sync SIGINT twin) never share a temp path (caught in review)
- [x] 2.3 `writeLiveMetricsSync(dir, data)`: synchronous twin for the signal-handler path (`writeFileSync` + `renameSync` + sync fsync)
- [x] 2.4 Unit tests: `status` defaults to `'running'`, never `'stalled'`

## 3. Targeted-path commit helper

- [x] 3.1 Add `commitPaths(repo, paths, message, opts?: { noVerify?: boolean })` to `src/util/git.ts`: filter to existing paths, `git add -f -- <paths>` (never a directory, never `-A`), skip the commit (return `null`) if nothing ends up staged, otherwise `git commit -m message -- <paths>` (`--no-verify` only when `opts.noVerify`) — the trailing pathspec on both the staged-check and the commit itself, not just the add, so unrelated content already staged in a dirty (`allowDirty`) tree is never swept into the commit (caught in review); return the new SHA. Unstages its own paths if the commit itself fails, so a blocked commit never leaves them sitting staged.
- [x] 3.2 Add the synchronous twin `commitPathsSync` using `execFileSync` (with a 5s timeout, since this runs from the SIGINT/SIGTERM handler whose whole point is to exit promptly), same semantics, for the signal-handler path
- [x] 3.3 Unit tests: commits only the named paths (assert via `git diff-tree --name-only`), no-op when none of the paths exist or nothing is staged, `noVerify` actually bypasses a failing hook while the default path respects it

## 4. Durable transcript event

- [x] 4.1 `Transcript.event()` in `src/agent/transcript.ts` gains `opts: { durable?: boolean } = {}`; when set, write via `open('a') → appendFile → sync → close` instead of the plain `appendFile`
- [x] 4.2 Add a free function `appendEventSync(jsonlPath, type, data)` (sync fs calls, redacted) for the signal-handler path, which cannot call into the async `Transcript` class
- [x] 4.3 Unit test: a `durable: true` event survives being read back immediately after the call resolves; redaction still applies on both the async and sync paths

## 5. Per-call events and heartbeat-driven metrics in the loop

- [x] 5.1 In `runWithMemory`'s turn loop (`src/agent/loop.ts`), on the success branch (alongside the existing `perTurn.push`), append a durable `llm-call` event with the full schema: `tokensIn`/`tokensOut` from `res.usage`, `cacheHit: res.cacheHit ?? false`, `cacheRead: 0`, `cacheWrite: 0`, `latencyMs` from `turnStartMs`, `stopReason: res.toolCalls.length ? 'tool_use' : 'text'`, `toolCalls: res.toolCalls.map(c => c.name)`, `error: null`
- [x] 5.2 On the error branch (before the `TurnTimeoutError`/rate-limit/session-limit branching, so every error type is covered), append the same event shape with zeroed tokens, `stopReason: 'error'`, `toolCalls: []`, `error: (err as Error).message`
- [x] 5.3 After each `llm-call` event, call `writeLiveMetrics` with the run's running totals and `status: 'running'`
- [x] 5.4 Inside the existing heartbeat `setInterval` callback, also call `writeLiveMetrics` so the file advances during a single long call
- [x] 5.5 Tests: one `llm-call` event per turn with correct fields (success and error cases, including the `stopReason: 'text'` no-tool-calls case, which is asserted directly, caught in review); `metrics.json` advances on heartbeat during a scripted slow turn; summed `tokensIn`/`tokensOut` across events equals `run-end`'s totals; per-call `cacheHit` propagation from a real `CachingProvider` hit is unit-tested directly (an end-to-end same-run `cacheHit`-sum-equals-`report.json`-`cacheHits` test would need a scripted provider wrapped in `CachingProvider`, which the test harness does not currently do — noted as a gap, not silently skipped)

## 6. SIGINT/SIGTERM handling

- [x] 6.1 In `runWithMemory`, register a fully synchronous handler via `process.prependListener('SIGINT', handler)` and `process.prependListener('SIGTERM', handler)` once `fail`/`stats`/`liveMetrics`/`artifactPaths` exist (not immediately after `transcript.init()` — nothing worth preserving exists before the turn loop starts anyway) — no `await` anywhere inside; use `writeLiveMetricsSync`, `appendEventSync`, and `commitPathsSync` only
- [x] 6.2 Handler does **not** call `restore()` or touch tracked files; it writes a final metrics snapshot, appends a `run-interrupted` transcript event, and (when `config.commitRunArtifacts`) commits the run-artifact files with `commitPathsSync(..., { noVerify: true })`, then calls `process.exit(130)`
- [x] 6.3 Remove both listeners in a `finally` around the run so repeated in-process invocations (tests, `create`'s per-stage loop) never stack handlers
- [x] 6.4 Tests: the underlying synchronous primitives (`writeLiveMetricsSync`, `appendEventSync`, `commitPathsSync`) are unit-tested directly, real-process-independent. A live cross-process `SIGINT` integration test (spawn the real CLI, send `SIGINT`, assert prompt exit + exactly one commit) was not written — see 11.2.

## 7. Artifact commits on the ordinary terminal paths

- [x] 7.1 In `fail()` (`src/agent/loop.ts`), after `writeSummary()` returns, call `commitPaths` (gated by `config.commitRunArtifacts`, hook-respecting, no `noVerify`) with `transcript.jsonlPath`, the metrics path, and the summary path, message `copperhead: partial run data <runId> (<exitPath>)`
- [x] 7.2 Add the same call to the refuse branch and the dry-run branch, after each one's own `restore()`/`writeSummary()`
- [x] 7.3 Add the same call to the `'done'` branch, after the existing design commit and the conditional openspec-archive commit, so it never amends either
- [x] 7.4 Tests: each terminal path (`done`, `refused`, dry-run, `provider-error`) produces exactly one artifacts commit containing only the three named files, as a real new commit distinct from the design commit; `commitRunArtifacts: false` produces none of them but still writes the files, with the path named in the log output

## 8. Stage-boundary reporting in create.ts

- [x] 8.1 `StageCost` in `src/commands/create.ts` gains `running?: boolean` (not a reused exit-path enum)
- [x] 8.2 Call `writeRunReport` when a stage starts (push a provisional `running: true` row) and again right after `completed.push(stage.name)` — today it is only called on the failure branch and once at full-pipeline end
- [x] 8.3 The stage-start `writeRunReport` call is disk-only — do **not** call `commitPaths` there (design D8: it runs before that stage's own `gitPreflight`, and committing there can cure a genuinely-fresh repo's "no commits" precondition before the real check ever runs). Call `commitPaths` (gated by `config.commitRunArtifacts`) with `REPORT.md`/`report.json`, message `copperhead: run report <stage.name>`, only at the stage-outcome call sites (success, failure/stop) and the final pipeline-end call
- [x] 8.4 Tests: an in-flight stage's row is written to `report.json` before that stage's own `runAgentLoop` call runs (proven via a mock that reads `report.json` at call time, not merely asserted after the fact — caught in review); the report and its commit are refreshed immediately after a bare stage success, not deferred to pipeline end; a dedicated D8 regression test (a fresh, zero-commit repo's first `runCreate` attempt still fails with "repository has no commits", not a later error) alongside the pre-existing `preflight.test.ts` coverage of the same scenario

## 9. Config flag

- [x] 9.1 `CopperheadConfig` in `src/config.ts` gains `commitRunArtifacts: boolean`, doc comment citing AC-4.3 and the opt-out
- [x] 9.2 `DEFAULTS.commitRunArtifacts = true`; `loadConfig` parses `raw.commitRunArtifacts !== false` (same pattern as `llmCache`)
- [x] 9.3 Test: an explicit `false` in `.copperhead/config.json` is honored; an absent key defaults to `true`

## 10. Documentation

- [x] 10.1 Update `copperheadReadme()`'s `## runs/` section in `src/memory/scaffold.ts`: replace "This directory is gitignored" with a precise description of the committed subset (`transcript.jsonl`, `metrics.json`, `summary.md`, `REPORT.md`, `report.json` — never the directory, never `llm-cache/`), the `commitRunArtifacts` opt-out, and precisely which artifacts redact secrets versus which are written directly (caught in review: an earlier draft overclaimed "all three redact")
- [x] 10.2 Add `### AC-16 · Incremental run metrics & artifact commits (issue #138)` to `openspec/specs/SPEC.md`, AC-16.1–16.9 mirroring the issue's acceptance criteria and this change's delta-spec scenarios

## 11. Verification

- [x] 11.1 Full offline suite: `npm run typecheck`, `npm run build`, `npm test`, `npm run lint:md` — all green (pre-existing failures unrelated to this change confirmed by running the identical suite against `main` with none of this branch's changes applied)
- [ ] 11.2 Manual: `copperhead do "..."` against the fixture repo, Ctrl-C mid-run — **not run**: no `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` or saved-login provider was available in the development environment, so the live-provider `do`/`create` paths this change touches could not be exercised end to end. `init`/`check` (LLM-free) were run for real instead; the loop-level behavior is covered by automated tests against the real `runAgentLoop`, including a real separate-process `SIGKILL` test (11.3), but a genuine live-provider Ctrl-C was not observed by a human.
- [ ] 11.3 Manual: `copperhead create` against the fixture repo, `kill -9` mid-stage — **not run live** for the same reason as 11.2. Substituted with an automated equivalent: `test/run-metrics.test.ts`'s "SIGKILL survival across a real process boundary" test spawns `runAgentLoop` (via a scripted provider, not a live model) in a genuinely separate OS process and confirms completed `llm-call` events and `metrics.json` survive a real `SIGKILL`. This proves the mechanism; it does not substitute for a human watching a real `create` pipeline get killed.
- [ ] 11.4 `openspec validate flush-run-metrics-incrementally` — **not run**: the `openspec` CLI is not installed in the development environment. These artifacts were written by hand, mirroring the structure and section conventions of the existing `record-run-metadata` change (the direct predecessor of the `run-observability` capability this change extends) as closely as possible without the CLI to validate against.
