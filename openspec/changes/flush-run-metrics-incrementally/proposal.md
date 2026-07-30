# Flush per-LLM-call logs and metrics incrementally

## Why

Run cost/metrics data is currently write-once at the end: `transcript.jsonl` gets its only accounting in a single `run-end` event (`src/agent/loop.ts`), and `.copperhead/runs/REPORT.md`/`report.json` (`src/commands/create.ts`) are regenerated only at full pipeline completion or on a stage's failure. A run that stalls, times out, or is killed mid-stage loses every bit of in-progress cost data — and even a run that *does* reach `run-end` never gets its transcript committed, because `.copperhead/runs/` is gitignored by design (AC-4.3). So the runs whose data is most worth keeping (the ones that didn't finish cleanly) are exactly the ones that leave nothing behind. This implements GitHub issue #138 (chouhanindustries/copperhead), filed against a concrete failure: a `layout-draft` stage ran 6m11s across 5 turns, hit a provider error mid-response, and left its transcript, `REPORT.md`, and `report.json` untracked, with per-call cost visible only by accident because the run happened to reach `run-end` first. Issues #139 and #140 are duplicates of the same request.

## What Changes

- Emit a new `llm-call` transcript event **after every provider call completes** (success or error), carrying per-call tokens, latency, model/provider, cache status, stop reason, tool calls, and error (if any) — written durably (open → write → fsync → close), not through the plain buffered append the rest of `transcript.jsonl` uses.
- `Turn` (`src/agent/types.ts`) gains a real `cacheHit?: boolean`, set by `CachingProvider` (`src/agent/response-cache.ts`) only on an actual on-disk-cache hit. `stopReason` is derived from `toolCalls.length` (no provider anywhere reports a real one). `cacheRead`/`cacheWrite` stay `0` — no per-provider prompt-cache token accounting exists in this codebase; faking nonzero values would be worse than omitting them.
- A new `.copperhead/runs/<runId>/metrics.json`, written atomically (temp file + rename + fsync) after every `llm-call` event and from the existing per-turn heartbeat, so it keeps advancing even during a single long or hung call — not just between turns.
- `.copperhead/runs/REPORT.md`/`report.json` regenerated at **every** stage boundary in `create.ts` (stage start and stage success), not only on stage failure or full-pipeline completion as today.
- `SIGINT`/`SIGTERM` handling in the agent loop — today there is none, so an interrupted run leaves nothing on disk beyond whatever synchronous writes happened to land. Unlike an unattended failure, an interrupt is user intent to stop *now*; the working tree is left exactly as it was (no rollback) and only a narrow, targeted commit of the run-artifact files is made.
- Every terminal path of a run (success, refusal, dry-run, failure, and now interrupt) makes a **new, standalone commit** of that run's `transcript.jsonl`, `metrics.json`, and `summary.md` — never amending an existing commit. `create.ts` separately commits the regenerated `REPORT.md`/`report.json` at each stage boundary.
- New config flag `commitRunArtifacts` (default `true`) governs all of the above commits; off, the files are still written to disk (so nothing is lost locally), just not committed. This is a real, user-visible default-behavior change from today, where `.copperhead/runs/` is unconditionally gitignored (AC-4.3) — called out explicitly below.

## Capabilities

### Modified Capabilities

- `run-observability` (added by `record-run-metadata`, SPEC.md AC-8): extends the existing `run-start`/`run-end`/`summary.md` reporting with per-call events, a live metrics file, stage-boundary report regeneration, interrupt handling, and artifact commits. No existing scenario in `record-run-metadata`'s delta spec is altered — `run-end`, `## Run stats`, and the exit-path enum are unchanged; this only adds new requirements alongside them.

## Impact

- `src/agent/types.ts` — `Turn` gains `cacheHit?: boolean`.
- `src/agent/response-cache.ts` — `CachingProvider.chat()` sets `cacheHit: true` on a real hit.
- `src/agent/metrics.ts` (new) — live `metrics.json` writer, atomic + fsync, with its own in-progress status vocabulary (not `RunStats`/`ExitPath`).
- `src/util/git.ts` — new `commitPaths`/`commitPathsSync` helpers: targeted `git add -f -- <exact paths>` (never a directory, never `-A`) plus a commit, used everywhere an artifact commit is made instead of amending.
- `src/agent/transcript.ts` — `event()` gains a `{ durable?: boolean }` option (fsync path); a new sync `appendEventSync` for the signal-handler path.
- `src/agent/loop.ts` — `llm-call` event emission on both success and error branches of the turn loop; heartbeat also refreshes `metrics.json`; `SIGINT`/`SIGTERM` handlers registered around the run; artifact-commit calls added to every terminal branch (`fail()`, refuse, dry-run, done).
- `src/commands/create.ts` — `writeRunReport` called at stage start and stage success, not only failure/pipeline end; a commit of `REPORT.md`/`report.json` after each write.
- `src/config.ts` — new `commitRunArtifacts: boolean` (default `true`).
- `src/memory/scaffold.ts` — the generated `.copperhead/README.md`'s `## runs/` section updated from "This directory is gitignored" to describe the new committed subset precisely.
- `openspec/specs/SPEC.md` — new **AC-16 · Incremental run metrics & artifact commits** block (AC-16.1 … AC-16.8), mapping 1:1 onto this change's delta-spec scenarios.
- Tests: extend `test/observability.test.ts`, add `test/run-metrics.test.ts` (including two real-child-process tests — SIGKILL and SIGINT — that can't be exercised by calling `runAgentLoop()` in-process).
- No new dependencies; existing `transcript.jsonl` consumers are unaffected (a new event type, existing types unchanged).
