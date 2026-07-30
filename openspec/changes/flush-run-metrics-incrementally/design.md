# Design — flush-run-metrics-incrementally

## Context

`runAgentLoop` (`src/agent/loop.ts`) is, as in `record-run-metadata`, the single choke point every run passes through — `do`, `create` (once per stage), `sync`'s resolve phase, and `repl` all reach it. It already owns the `Transcript` (JSONL + `summary.md`), `stats()` (the closure that builds `RunStats` at every terminal branch), and `fail()` (the shared failure handler that already does rollback + report + summary for every unattended failure path). What's missing is per-call granularity between turns, a live cross-process-readable file that survives a hang or a kill, and any reaction at all to `SIGINT`/`SIGTERM`.

Two things this design has to work around, found by reading the code rather than assuming:

1. `.copperhead/runs/` is gitignored by default in target repos (AC-4.3; confirmed by `src/util/git.ts`'s `restore()`, which backs the directory up around `git clean -fd` specifically because it is untracked, with the comment "intentionally untracked; their audit contents are ignored by the target-repository convention"). `commitAll()`'s plain `git add -A` therefore never picks up run artifacts today — this change is deliberately turning that off for a named, narrow subset of files, not a bug fix.
2. `src/agent/render.ts`'s `InteractiveRenderer` and `src/commands/repl.ts`'s `runRepl` **already** register `SIGINT` listeners, each of which calls `process.exit()` synchronously (`render.ts:102-105`, `repl.ts:387-390`), constructed before `runAgentLoop`/`runCreate` is ever called. Node's `EventEmitter` invokes every registered `SIGINT` listener synchronously, in order, in one tick. Anything this change adds has to either run before those listeners or finish before they get a chance to call `process.exit()`.

## Goals / Non-Goals

**Goals:**

- Per-call cost data is on disk before the *next* call starts, and survives the process being killed.
- A live, current `metrics.json` exists for the whole lifetime of a run, including during a single call that runs long.
- `REPORT.md`/`report.json` reflect an in-flight stage, not just a finished or failed one.
- Every terminal path — including a user-initiated interrupt, which today leaves nothing — commits its run artifacts (opt-out via config).
- Nothing here changes an existing `run-end`/`RunStats`/exit-path contract from `record-run-metadata`.

**Non-Goals:**

- Real per-provider prompt-cache token accounting (`cacheRead`/`cacheWrite` as actual nonzero numbers) — would touch every provider file (`openai.ts`, `anthropic.ts`, `claude-code.ts`, `codex.ts`, `cursor.ts`) for a field the issue's own schema shows as `0` even in its "hit" example. Left as a documented follow-up.
- Rolling back the working tree on `SIGINT`/`SIGTERM` — see D5.
- A `metrics.flushPerCall` opt-out — see D6.
- Changing anything about `check`/`init`, which never enter the loop.

## Decisions

### D1 — `cacheHit` is a real field on `Turn`, set by the one thing that actually caches

`CachingProvider.chat()` (`src/agent/response-cache.ts`) is the only cache in this codebase — copperhead's own on-disk turn-replay cache, already counted by its `cacheHits` getter, which `report.json`'s `cacheHits` already sums. `Turn` gains `cacheHit?: boolean`; `CachingProvider` sets it `true` alongside the existing zero-usage override on a hit, and leaves it `undefined` on a miss (real providers never set it, so `res.cacheHit ?? false` is always correct). This is the only design under which "per-call `cacheHit` sums equal `report.json`'s `cacheHits`" (AC-16.8) can be true by construction, rather than by coincidence.

`stopReason` is *not* added as a field anywhere — no provider in this codebase reports one. It is derived once, in the loop, from data already on `Turn`: `res.toolCalls.length ? 'tool_use' : 'text'` on success, `'error'` on the error branch. Inventing a provider-reported field that nothing actually sets would be worse than deriving an honest one.

### D2 — `metrics.json` has its own status vocabulary, not `RunStats`/`ExitPath`

`ExitPath` (`src/agent/transcript.ts`) is a closed, *terminal* enum — `'done' | 'refused' | ... | 'stalled'`. A live, in-progress `metrics.json` is not in a terminal state, so it needs a value that isn't a lie. `src/agent/metrics.ts` defines its own `LiveMetrics.status: 'running' | 'stalled' | ExitPath` — `'running'` for the entire duration of a healthy run, `'stalled'` only when the loop's own existing stall detector fires (`nudges >= 2`, `loop.ts:596`), and one of the real `ExitPath` values once the run actually reaches a terminal branch and writes its last `metrics.json` snapshot. A design that defaults in-progress writes to `'stalled'` (as a placeholder meaning "not terminal yet") would report every healthy run as stalled for its entire duration, which is a real bug, not a simplification — worth naming explicitly since it's the single most concrete defect found while reviewing the file-shape space around this feature.

### D3 — Durable write only for `llm-call`, not every event

`Transcript.event()`'s existing `await appendFile(...)` already survives a bare `SIGKILL` of the Node process — the write syscall completes before the promise resolves; only a concurrent OS crash/power-loss needs fsync, which is out of scope. `event()` gains an opt-in `{ durable?: boolean }` that additionally does `open → write → fsync → close` for that one call. Applied only to `llm-call` (the event this change's SIGKILL acceptance criterion is actually about) — every other event type (`tool`, `assistant`, …) keeps the cheaper plain append; those aren't the thing being tested, and fsyncing dozens of high-frequency `tool` events per run for no required guarantee would be needless I/O.

### D4 — `metrics.json` also refreshes on the existing heartbeat, not just per call

A call that never completes (hung, not just slow) means the turn loop's own `await provider.chat(...)` never returns, so a write that only happens "after each call" cannot happen at all while a single call is stuck — `metrics.json` would go stale for the entire hang, which fails AC-16.3's "stays current while the run is in progress." `loop.ts` already runs a `setInterval` heartbeat during an in-flight call (`heartbeatMs`, unref'd) purely for the CLI's liveness display; this change adds a `writeLiveMetrics` call to that same callback. This is safe under Node's single-threaded event loop precisely because the existing test `'the loop fires a heartbeat while a slow provider turn is in flight'` already proves the interval fires *during* a pending `await` on genuine async I/O (HTTP or subprocess) — the same property this reuses, not a new assumption.

### D5 — `SIGINT`/`SIGTERM`: synchronous handler, `prependListener`, and deliberately no rollback

Two hazards, found by reading `render.ts`/`repl.ts` rather than assumed:

- **Ordering.** `InteractiveRenderer` and `runRepl` each already register a `SIGINT` listener that calls `process.exit()` synchronously, constructed *before* the loop runs. An `async` handler registered later via `process.on(...)` would merely start a promise and return control immediately to Node's listener dispatch, which then calls the earlier listener's `process.exit()` before any awaited cleanup runs. The fix: register with `process.prependListener('SIGINT'|'SIGTERM', handler)` so this change's handler runs *first*, and make the handler **fully synchronous** — no `await`, sync `fs`/`execFileSync` calls only — so it completes entirely within its own turn of the event loop before control ever reaches the next listener. It ends by calling `process.exit(130)` itself.
- **Rollback is the wrong default for a deliberate interrupt.** `fail()`'s path (preserve → `restore()` → write summary) is designed for an *unattended* failure, where discarding the run's edits is the safe default. A `SIGINT` is the user saying "stop now," a different intent — auto-discarding in-progress edits they may want to inspect or finish by hand is arguably wrong, not just risky. Replicating `restore()`'s multi-step async dance (tmpdir backup, `git reset --hard`, `git clean -fd`, conditional stash-apply) synchronously would also be its own source of new failure modes, especially with an in-flight subprocess a killed turn may have spawned. So: on interrupt, the working tree is left exactly as the interrupted turn left it. Only a final `metrics.json` snapshot and a narrow `commitPathsSync` of the run-artifact files are made, gated by `commitRunArtifacts`.

This is a deliberate behavioral asymmetry from every other terminal path in this change, and is called out here for that reason — flag for maintainer confirmation if a rollback-on-interrupt is actually wanted instead.

### D6 — The interrupt-path commit is the one place `--no-verify` is justified — narrowly

Every other artifact commit in this change goes through the ordinary, hook-respecting path (`commitAll`'s pattern: plain `git commit -m`, no flags) — after `restore()` or after a stage's already-hook-passed design commit, the tree is already verified, so the hook (`exec copperhead check`, `src/memory/scaffold.ts`) passes cheaply and there's no reason to skip it. The interrupt path is the one exception: because D5 deliberately skips `restore()`, the tree can be mid-edit (a half-applied multi-file edit, an ERC-failing intermediate state) at the moment of `SIGINT`. Running a full ERC/DRC subprocess tree in a synchronous, must-complete-before-exit signal handler would be slow and could itself fail, defeating the one commit meant to save the audit trail during an emergency shutdown. `commitPathsSync` there passes `noVerify: true`, with this reasoning as a code comment — a scoped, justified exception, not the blanket `--no-verify` a naive implementation might reach for on every commit.

### D7 — `commitRunArtifacts` defaults to `true`; no `metrics.flushPerCall` opt-out

`commitRunArtifacts: boolean` (default `true`) is a real, user-visible change from today's default: AC-4.3 currently promises `.copperhead/runs/` is never committed, and `scaffold.ts`'s generated README says exactly that. Off, every write in this change still happens (nothing is lost locally); only the targeted `git add -f` + commit calls are skipped, and `fail()`/the interrupt path log the artifact path explicitly so "clearly report the uncommitted path" (AC-16.6's fallback clause) is satisfied either way. The issue's own suggested `metrics.flushPerCall` flag is deliberately **not** added: per-call flushing is the reliability guarantee this whole issue is about (AC-16.1–16.3); making it optional would let a user silently defeat exactly the acceptance criteria this change exists to satisfy.

## Risks / Trade-offs

- [`commitRunArtifacts: true` is a default-behavior change against AC-4.3] → called out explicitly in `proposal.md`'s Impact; `scaffold.ts`'s generated README is updated in the same change so the documented contract and the actual behavior never disagree, unlike before this change.
- [Committing full transcripts could leak proprietary schematic/part discussion into git history] → this is exactly what the opt-out flag is for; the artifact set is five named files, never the whole `.copperhead/runs/` directory, and never `llm-cache/` (which keeps its own `*` .gitignore, untouched by this change).
- [An artifact commit on every terminal branch adds git subprocess overhead to every run] → each commit stages a handful of small, already-known paths (`git add -f -- <exact paths>`, never a repo-wide `-A` scan); negligible against multi-minute runs.
- [The interrupt path's `--no-verify` could, in principle, commit an ERC-failing intermediate schematic] → true, and accepted: it commits only the audit-trail files (`transcript.jsonl`/`metrics.json`/`summary.md`), never the design files themselves, which are left uncommitted and untouched in the working tree exactly as D5 describes.
- [Two listeners now compete for `SIGINT` in the interactive path — this change's and `render.ts`'s] → resolved by `prependListener` plus a fully synchronous handler (D5); a regression test spawns the real CLI and asserts the process still exits promptly and the terminal-restore behavior in `render.ts` is unaffected.
- [Heartbeat-driven `metrics.json` writes during a hang add filesystem work on top of an already-slow call] → one small JSON file, at the existing `heartbeatMs` cadence (default 30s) — the same cadence already used for the CLI's own liveness line.

### D8 — The stage-start report write is disk-only; committing it there can cure the very precondition gitPreflight exists to catch

Found during implementation, not anticipated in the original design: `create.ts`'s stage loop pushes a provisional `running: true` `StageCost` and writes the report *before* that stage's own `runAgentLoop` call — which is also *before* that call's `gitPreflight` has validated the repo even once. On a genuinely fresh repo (git initialized, zero commits — exactly the case `gitPreflight`'s "repository has no commits" refusal exists for), committing the stage-start report there creates the repo's first commit out of a `REPORT.md` write, silently curing the "no commits yet" precondition before the real preflight check ever runs. A test (`preflight.test.ts`'s "unborn HEAD: create fails with the no-commits message instead of crashing in spec-seed") caught this directly: with the stage-start commit in place, `runCreate` no longer failed with "repository has no commits" — it got past that check (because the repo now had one) and failed differently once the model provider couldn't be resolved instead.

Fix: the stage-start write stays exactly as designed (`writeRunReport` only — visibility into an in-flight stage), but the stage-start `commitReportArtifacts` call is removed entirely. Committing the report is deferred to a stage's actual boundary — success, failure, or stop — plus the final pipeline-end write, all of which run only after at least one real `gitPreflight` has already passed for that repo. AC-16.4 (report regeneration) is unaffected — the write still happens at stage start, satisfying "an in-flight stage appears in the report." Only AC-16.5's commit obligation moves to the later boundary.

## Open Questions

- Whether AC-16.5 ("each stage commit contains that stage's transcript, metrics, summary, and the regenerated report") is satisfied by **two** commits landing back-to-back at a stage boundary (the per-run artifacts commit from `loop.ts`, then `create.ts`'s own `REPORT.md`/`report.json` commit) rather than one combined commit — this design uses two, because `loop.ts` has no visibility into the pipeline-level report and `create.ts` has no visibility into a single run's transcript/metrics. Flagged for maintainer confirmation; splitting is the only option that doesn't require either module to reach into the other's concerns.
