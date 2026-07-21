# Design — record-run-metadata

## Context

`runAgentLoop` (`src/agent/loop.ts`) is the single choke point every LLM run passes through: `do` calls it directly, `create` calls it once per pipeline stage, and `sync`'s resolve phase reaches it too. It already owns the `Transcript` (JSONL + `summary.md`), the run id, and the `log` callback used for live CLI output — so all three metadata surfaces are reachable from one place. What's missing is (a) run context the loop is never told (copperhead version, command, stage position, how the model was selected), (b) deterministic environment probes (versions, git state, hook presence), and (c) per-turn accounting beyond two token counters.

Constraints inherited from SPEC.md: metadata collection must be LLM-free and deterministic; transcripts and summaries are redacted at write time (AC-4.1); `check` stays untouched (it never enters the loop).

## Goals / Non-Goals

**Goals:**

- Every run is self-describing from its artifacts alone: build, model + why that model, config, repo state, stage.
- Post-run stats (usage vs budgets, duration, exit path) in the same artifacts, including on failure paths.
- Live CLI output that shows run context up front and progress against the turn budget.
- A commit failure becomes a first-class outcome in `summary.md`, not a raw stack trace.

**Non-Goals:**

- Cost estimation in currency (price tables go stale; tokens are the durable unit). Issue #22 lists "estimated cost" as suggested — deferred.
- Per-stage aggregate reporting across a whole `create` pipeline (each stage run is already a self-describing run; a pipeline-level rollup is future work).
- Structured logging frameworks, log levels, or a `--verbose` flag — the existing `log` callback stays the transport.
- Changing what `check`/`init` print.

## Decisions

### D1 — One `RunMeta` object, collected once, rendered three ways

A new module `src/agent/runmeta.ts` exports `collectRunMeta(...): Promise<RunMeta>` plus pure renderers `renderCliHeader(meta)` and `renderEnvironmentSection(meta)`. The loop collects once (after `loadConfig`, before turn 1), emits the full object as the `run-start` event's data, prints the CLI header, and stores the object for `writeSummary`. Rationale: three surfaces must never disagree, so they must share one source object; pure renderers make the formatting unit-testable offline. Alternative — collecting ad hoc at each surface — was rejected because the surfaces would drift (the exact failure mode issue #22 describes).

### D2 — Callers pass identity down; the loop probes the environment itself

`RunOptions` gains an optional `meta` field: `{ command: 'do'|'create'|'sync', modelSource: ModelSource, version: string, stage?: { name: string; index: number; total: number }, brief?: { path: string; sha256: string } }`. The CLI layer knows the command, version, and model-selection source; `create` knows stage position and the brief; the loop itself probes everything environmental (kicad-cli/node/platform, git state, constraint and run counts, install path via `import.meta.url`). Rationale: each fact is collected where it is authoritative. The field is optional so existing tests and programmatic callers keep working (missing values render as `unknown`).

### D3 — `resolveModel` returns the winning source

`resolveModel` currently returns a bare string; the selection source is decided there and nowhere else. It changes to return `{ model: string; source: 'flag'|'env'|'config'|'openai-key'|'anthropic-key' }`. All call sites (`do`, `create`, `sync`) update. Alternative — a second `resolveModelSource()` — rejected: two functions re-implementing the same precedence chain is how they fall out of sync.

### D4 — Probes degrade to `null`, never fail the run

Each environment probe (git branch, hook presence, kicad-cli version, …) is individually try/caught; a failed probe records `null` for that field and the run proceeds. Rationale: metadata exists to debug runs; a metadata bug must never abort or alter one. `kicad-cli` version reuses the value the CLI already fetched at preflight where practical (passed through `meta`), avoiding a second subprocess.

### D5 — Exit path is an enum threaded through every terminal branch

`RunResult` and the summary gain `exitPath: 'done' | 'refused' | 'turn-budget-exhausted' | 'repair-cycles-exhausted' | 'commit-failed' | 'provider-error' | 'stalled'`. The `fail(reason)` helper gains an exit-path argument; the final `commitAll` is wrapped so a git failure routes through `fail(..., 'commit-failed')` with rollback — today it propagates as an unhandled throw and the summary is never written. The archive commit is wrapped separately: by then the verified run commit already exists, so its failure is caught, recorded (`openspec-archive-failed` event + CLI warning), and the run stays `done` — discarding a verified commit over archive housekeeping would be the worse trade. Rationale: the exit path is the single most-queried fact when triaging; deriving it from prose `detail` strings is guesswork.

### D6 — Addenda live in a `run-end` event plus summary/CLI rendering

At every terminal branch the loop emits one `run-end` event `{ exitPath, turnsUsed, maxTurns, repairCyclesUsed, maxRepairCycles, tokensIn, tokensOut, perTurn: [{turn, in, out}], durationMs }`, renders a `## Run stats` section in `summary.md`, and logs a one-line CLI outcome. Per-turn token rows are captured from the existing `res.usage` values already in hand — no provider changes. Duration uses a monotonic start timestamp taken at collection time.

### D7 — A progress renderer with two modes: interactive on a TTY, plain lines otherwise

A new `src/agent/render.ts` exports a `ProgressRenderer` that the CLI constructs and hands to the loop as its `log` implementation plus a small event surface (`turnStart`, `toolResult`, `status`, `finish`). Two modes, chosen once at startup:

- **Interactive** (stdout is a TTY, `--json` is off, and `--plain` is not passed), inspired by the Claude Code CLI: a persistent status line pinned to the bottom of the terminal and redrawn in place — `⠋ turn 7/40 · 12.3k in / 4.1k out · 1m32s` with a braille spinner animating while a provider call is in flight. Assistant text and one-line tool results print above it (clear status line → print → redraw), so the scrollback stays a clean, complete log. The final outcome line replaces the status line.
- **Plain** (not a TTY, `--json`, or the global `--plain` flag — for users who prefer scrolling logs, and for tee/script sessions where `isTTY` is true but redraws are unwanted): exactly the line-oriented output described elsewhere in this design — `[turn k/N · <in>k in / <out>k out]` markers, indented `[tool] first-line` results, no ANSI escape codes at all. This is also the mode all offline tests assert against.

Token figures are the run's cumulative totals, already accumulated in `tokensIn`/`tokensOut`, formatted compactly (`12.3k`, plain integers below 1000). The header stays two lines in both modes (`copperhead vX.Y.Z (path) · kicad-cli A.B · node vN · <platform>` and `run <id> · <command>[ · stage k/N name] · model <id> (<provider>, via <source>) · turns ≤N · repo <branch>@<short-sha> <clean|dirty(n)>`).

Implementation is hand-rolled ANSI (cursor-to-column-0, clear-line, hide/show cursor on start/exit including SIGINT) — no `ora`/`ink` dependency; the repo currently has zero rendering deps and the needed subset is ~60 lines. `RunOptions.log` keeps its `(line: string) => void` shape so existing tests and `create`/`sync` call sites keep working; the renderer implements it. Rationale: interactivity is a rendering concern, so it lives behind the same seam the loop already uses, and the plain mode preserves CI/`--json` behavior and test determinism. Alternative — adopting `ink` (what Claude Code itself uses) — rejected as a heavy React-based dependency for one status line.

### D8 — Redaction covers the new fields for free

`transcript.event` and `writeSummary` already pass everything through `redactSecrets` at write time. Metadata goes through those same paths; no new redaction code. A test asserts a key planted in an env-derived field (e.g. a hypothetical base-URL with a token) comes out redacted.

## Risks / Trade-offs

- [Enriched `run-start` breaks consumers of the old 3-field shape] → the old fields (`request`, `model`, `provider`) keep their names and positions inside the new object; tests assert their presence explicitly.
- [Git probes add latency at run start] → all probes are read-only, local, and run concurrently via `Promise.all`; budget is tens of milliseconds against multi-minute runs.
- [`resolveModel` signature change ripples] → only three call sites, all in this repo; changed atomically in one task.
- [Per-turn token array grows unbounded on long runs] → bounded by `maxTurns` (default 40); at worst a few KB in the transcript.
- [Brief hash reads the brief twice (create already reads it)] → hash computed in `create.ts` from the content it already holds; no second read.
- [Interactive mode leaves the terminal in a bad state (hidden cursor, orphaned status line) on crash or Ctrl-C] → cursor restore and status-line cleanup registered on `exit` and SIGINT; plain mode has no terminal state at all.
- [In-place redraws corrupt output when the interactive-mode detection is wrong (e.g. a smart pipe)] → mode is decided solely by `process.stdout.isTTY`, `--json`, and `--plain`; no capability sniffing beyond that, and plain mode is always the safe fallback (and can be forced with `--plain`).

## Open Questions

- None blocking. Currency cost estimation and pipeline-level rollups are explicitly deferred (see Non-Goals).
