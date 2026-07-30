# Tasks — flush-run-metrics-incrementally

## 1. Real cache-hit signal

- [ ] 1.1 Add `cacheHit?: boolean` to `Turn` in `src/agent/types.ts`
- [ ] 1.2 `CachingProvider.chat()` in `src/agent/response-cache.ts` sets `cacheHit: true` on the hit path alongside the existing zero-usage override; miss path returns the inner `Turn` unchanged

## 2. Live metrics module

- [ ] 2.1 Create `src/agent/metrics.ts`: `LiveMetrics` type (`status: 'running' | 'stalled' | ExitPath`, run id, turn/maxTurns, token totals, cache hits, `startedAt`/`lastUpdateAt`) — a distinct type from `RunStats`/`ExitPath`, not a reuse
- [ ] 2.2 `writeLiveMetrics(dir, data)`: atomic write (temp file + `rename`) with an `fsync` before rename
- [ ] 2.3 `writeLiveMetricsSync(dir, data)`: synchronous twin for the signal-handler path (`writeFileSync` + `renameSync` + sync fsync)
- [ ] 2.4 Unit tests: atomic write leaves no partial file visible under a forced write failure; `status` defaults to `'running'`, never `'stalled'`

## 3. Targeted-path commit helper

- [ ] 3.1 Add `commitPaths(repo, paths, message, opts?: { noVerify?: boolean })` to `src/util/git.ts`: filter to existing paths, `git add -f -- <paths>` (never a directory, never `-A`), skip the commit (return `null`) if nothing ends up staged, otherwise `git commit -m message` (`--no-verify` only when `opts.noVerify`), return the new SHA
- [ ] 3.2 Add the synchronous twin `commitPathsSync` using `execFileSync`, same semantics, for the signal-handler path
- [ ] 3.3 Unit tests: commits only the named paths (assert via `git show --stat`), no-op when none of the paths exist or nothing is staged, `noVerify` actually bypasses a failing hook while the default path respects it

## 4. Durable transcript event

- [ ] 4.1 `Transcript.event()` in `src/agent/transcript.ts` gains `opts: { durable?: boolean } = {}`; when set, write via `open('a') → appendFile → sync → close` instead of the plain `appendFile`
- [ ] 4.2 Add a free function `appendEventSync(jsonlPath, type, data)` (sync fs calls, redacted) for the signal-handler path, which cannot call into the async `Transcript` class
- [ ] 4.3 Unit test: a `durable: true` event survives being read back immediately after the call resolves; redaction still applies on both the async and sync paths

## 5. Per-call events and heartbeat-driven metrics in the loop

- [ ] 5.1 In `runWithMemory`'s turn loop (`src/agent/loop.ts`), on the success branch (alongside the existing `perTurn.push`), append a durable `llm-call` event with the full schema: `tokensIn`/`tokensOut` from `res.usage`, `cacheHit: res.cacheHit ?? false`, `cacheRead: 0`, `cacheWrite: 0`, `latencyMs` from `turnStartMs`, `stopReason: res.toolCalls.length ? 'tool_use' : 'text'`, `toolCalls: res.toolCalls.map(c => c.name)`, `error: null`
- [ ] 5.2 On the error branch (before the `TurnTimeoutError`/rate-limit/session-limit branching, so every error type is covered), append the same event shape with zeroed tokens, `stopReason: 'error'`, `toolCalls: []`, `error: (err as Error).message`
- [ ] 5.3 After each `llm-call` event, call `writeLiveMetrics` with the run's running totals and `status: 'running'`
- [ ] 5.4 Inside the existing heartbeat `setInterval` callback, also call `writeLiveMetrics` so the file advances during a single long call
- [ ] 5.5 Tests: one `llm-call` event per turn with correct fields (success and error cases); `metrics.json` advances on heartbeat during a scripted slow turn (reuse the `SlowStreamingProvider` pattern already in `test/observability.test.ts`); summed `tokensIn`/`tokensOut` across events equals `run-end`'s totals; summed `cacheHit: true` count equals `report.json`'s `cacheHits`

## 6. SIGINT/SIGTERM handling

- [ ] 6.1 In `runWithMemory`, after `transcript.init()`, register a fully synchronous handler via `process.prependListener('SIGINT', handler)` and `process.prependListener('SIGTERM', handler)` — no `await` anywhere inside; use `writeLiveMetricsSync`, `appendEventSync`, and `commitPathsSync` only
- [ ] 6.2 Handler does **not** call `restore()` or touch tracked files; it writes a final metrics snapshot, appends a `run-interrupted` transcript event, and (when `config.commitRunArtifacts`) commits the run-artifact files with `commitPathsSync(..., { noVerify: true })`, then calls `process.exit(130)`
- [ ] 6.3 Remove both listeners in a `finally` around the run so repeated in-process invocations (tests, `create`'s per-stage loop) never stack handlers
- [ ] 6.4 Tests (real child process via `execa`, spawning the actual CLI): `SIGINT` mid-run exits promptly with code 130, produces exactly one artifact commit, and leaves non-run tracked files untouched; a second `SIGINT` doesn't double-commit or hang; the existing `InteractiveRenderer` terminal-restore behavior still fires

## 7. Artifact commits on the ordinary terminal paths

- [ ] 7.1 In `fail()` (`src/agent/loop.ts`), after `writeSummary()` returns, call `commitPaths` (gated by `config.commitRunArtifacts`, hook-respecting, no `noVerify`) with `transcript.jsonlPath`, the metrics path, and the summary path, message `copperhead: partial run data <runId> (<exitPath>)`
- [ ] 7.2 Add the same call to the refuse branch and the dry-run branch, after each one's own `restore()`/`writeSummary()`
- [ ] 7.3 Add the same call to the `'done'` branch, after the existing design commit and the conditional openspec-archive commit, so it never amends either
- [ ] 7.4 Tests: each terminal path (`done`, `refused`, dry-run, `provider-error`, `turn-budget-exhausted`, `commit-failed`) produces exactly one artifacts commit containing only the three named files; `commitRunArtifacts: false` produces none of them but still writes the files, with the path named in the log output

## 8. Stage-boundary reporting in create.ts

- [ ] 8.1 `StageCost` in `src/commands/create.ts` gains `running?: boolean` (not a reused exit-path enum)
- [ ] 8.2 Call `writeRunReport` when a stage starts (push a provisional `running: true` row) and again right after `completed.push(stage.name)` — today it is only called on the failure branch and once at full-pipeline end
- [ ] 8.3 The stage-start `writeRunReport` call is disk-only — do **not** call `commitPaths` there (design D8: it runs before that stage's own `gitPreflight`, and committing there can cure a genuinely-fresh repo's "no commits" precondition before the real check ever runs). Call `commitPaths` (gated by `config.commitRunArtifacts`) with `REPORT.md`/`report.json`, message `copperhead: run report <stage.name>`, only at the stage-outcome call sites (success, failure/stop) and the final pipeline-end call
- [ ] 8.4 Tests: an in-flight stage's row shows `running` in `report.json` before it finishes (verified via the report already being on disk when the stage's own `runAgentLoop` call is made, not via a commit); the report and its commit are refreshed immediately after a bare stage success, not deferred to pipeline end; a regression test for D8 (a fresh, zero-commit repo's first `runCreate` attempt still fails with "repository has no commits", not a provider-resolution error)

## 9. Config flag

- [ ] 9.1 `CopperheadConfig` in `src/config.ts` gains `commitRunArtifacts: boolean`, doc comment citing AC-4.3 and the opt-out
- [ ] 9.2 `DEFAULTS.commitRunArtifacts = true`; `loadConfig` parses `raw.commitRunArtifacts !== false` (same pattern as `llmCache`)
- [ ] 9.3 Test: an explicit `false` in `.copperhead/config.json` is honored; an absent key defaults to `true`

## 10. Documentation

- [ ] 10.1 Update `copperheadReadme()`'s `## runs/` section in `src/memory/scaffold.ts`: replace "This directory is gitignored" with a precise description of the committed subset (`transcript.jsonl`, `metrics.json`, `summary.md`, `REPORT.md`, `report.json` — never the directory, never `llm-cache/`) and the `commitRunArtifacts` opt-out
- [ ] 10.2 Add `### AC-16 · Incremental run metrics & artifact commits (issue #138)` to `openspec/specs/SPEC.md`, AC-16.1–16.8 mirroring the issue's acceptance criteria and this change's delta-spec scenarios

## 11. Verification

- [ ] 11.1 Full offline suite: `npm run typecheck`, `npm run build`, `npm test`, `npm run lint:md`
- [ ] 11.2 Manual: `copperhead do "..."` against the fixture repo, Ctrl-C mid-run — confirm prompt exit, one artifact commit, untouched design files
- [ ] 11.3 Manual: `copperhead create` against the fixture repo, `kill -9` mid-stage — confirm `metrics.json` and completed `llm-call` events survive on disk
- [ ] 11.4 `openspec validate flush-run-metrics-incrementally`
