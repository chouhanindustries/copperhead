# run-observability — Delta Spec

## ADDED Requirements

### Requirement: Every LLM call appends a durable transcript event before the next call starts

The agent loop SHALL append an `llm-call` event to `transcript.jsonl` immediately after each provider call resolves or rejects, and before the next turn's provider call begins. The event's `data` SHALL contain: `turn`, `stage` (or `null` outside a `create` pipeline), `callId`, `model`, `provider`, `tokensIn`, `tokensOut`, `cacheRead`, `cacheWrite`, `cacheHit`, `latencyMs`, `startedAt`, `finishedAt`, `stopReason`, `toolCalls` (an array of tool names), and `error` (`null` on success). This event SHALL be written durably (flushed and fsynced) rather than through the transcript's ordinary buffered append, so a process killed immediately afterward cannot lose it. A call that errors (provider error, turn timeout) SHALL still append an event, with `tokensIn`/`tokensOut` at `0`, `stopReason: 'error'`, `toolCalls: []`, and `error` set to the failure message.

#### Scenario: A successful multi-turn run logs one event per call
- **WHEN** a run completes 3 turns, each producing tool calls
- **THEN** `transcript.jsonl` contains exactly 3 `llm-call` events, each appended before the following turn's event, with `tokensIn`/`tokensOut` matching that turn's usage and `toolCalls` matching that turn's tool-call names

#### Scenario: A provider error still produces an event
- **WHEN** a turn's provider call throws before exhausting turn-timeout retries
- **THEN** an `llm-call` event is appended for that turn with `stopReason: 'error'`, `tokensIn`/`tokensOut` of `0`, and `error` containing the failure message

#### Scenario: Summed per-call totals match the run-end totals
- **WHEN** a run ends cleanly after several turns
- **THEN** the sum of `tokensIn`/`tokensOut` across all `llm-call` events equals `tokensIn`/`tokensOut` in the `run-end` event

#### Scenario: Per-call cache hits match the reported cache-hit count
- **WHEN** a stage retried after an earlier attempt replays some turns from the on-disk response cache
- **THEN** the count of `llm-call` events with `cacheHit: true` equals the `cacheHits` value in `.copperhead/runs/report.json` for that stage

### Requirement: A live metrics file exists and stays current for the duration of a run

The agent loop SHALL maintain `.copperhead/runs/<runId>/metrics.json`, written atomically (temp file plus rename), updated after every `llm-call` event and additionally on every liveness-heartbeat tick while a call is in flight. Its `status` field SHALL be `'running'` for the entire duration of a healthy run, one of the loop's real terminal exit-path values once the run reaches a terminal branch, and `'stalled'` only when the loop's own existing stall detector (consecutive tool-less turns) fires — never as a default placeholder for "not yet finished."

#### Scenario: metrics.json exists after the first call
- **WHEN** a run's first turn completes
- **THEN** `.copperhead/runs/<runId>/metrics.json` exists, is valid JSON, and its `status` is `'running'`

#### Scenario: metrics.json advances during a single long call
- **WHEN** a single provider call runs long enough for multiple heartbeat intervals to fire before it resolves
- **THEN** `metrics.json`'s last-update timestamp advances at each heartbeat, without waiting for the call to complete

#### Scenario: A healthy run never reports itself as stalled
- **WHEN** a run is in progress and has not tripped the stall detector
- **THEN** every `metrics.json` snapshot written during the run has `status: 'running'`, never `'stalled'`

#### Scenario: SIGKILL leaves completed calls' data on disk
- **WHEN** a run is killed with `SIGKILL` partway through a stage, after two calls have completed and a third is in flight
- **THEN** `transcript.jsonl` contains `llm-call` events for the two completed calls, and `metrics.json` reflects their totals

### Requirement: REPORT.md and report.json are regenerated at each stage boundary

The `create` pipeline SHALL regenerate `.copperhead/runs/REPORT.md` and `report.json` when a stage starts and when a stage's outcome (success, failure, or exhausted retries) is known — not only at full-pipeline completion or on the final failing stage as before this change. A stage in progress SHALL appear in the report as `running`; a stage whose run reports `stalled` SHALL appear as `stalled`.

#### Scenario: An in-flight stage appears in the report
- **WHEN** `create` is partway through a stage that has not yet finished
- **THEN** `report.json` contains a row for that stage with status `running`, generated before the stage completes

#### Scenario: A completed stage's report is regenerated immediately
- **WHEN** a stage finishes successfully
- **THEN** `REPORT.md`/`report.json` are rewritten to include that stage's final numbers before the next stage starts, not deferred until the pipeline or a later failure

### Requirement: Run artifacts are committed on every terminal path, as new standalone commits

When `config.commitRunArtifacts` is `true` (the default), every terminal path of a run — success, refusal, dry-run, and unattended failure — SHALL make a new, standalone git commit containing only that run's `transcript.jsonl`, `metrics.json`, and `summary.md`, added by exact path (never a directory, never `git add -A`). This commit SHALL NOT amend any existing commit. The `create` pipeline SHALL separately commit the regenerated `REPORT.md`/`report.json` after each stage-boundary report write. When `commitRunArtifacts` is `false`, these files SHALL still be written to disk, and the run's output SHALL state their path explicitly as uncommitted.

#### Scenario: A successful stage commits its own artifacts, not amended onto the design commit
- **WHEN** a `create` stage finishes successfully and makes its design commit
- **THEN** a separate, later commit exists containing exactly `transcript.jsonl`, `metrics.json`, and `summary.md` for that run, and the design commit's own file list is unchanged
- **AND** if the stage also produced an OpenSpec-archive commit, the artifacts commit is still separate from both, never amending either

#### Scenario: A provider-error run still leaves its data committed
- **WHEN** a run ends with exit path `provider-error` or `turn-timeout`
- **THEN** a commit containing that run's `transcript.jsonl`, `metrics.json`, and `summary.md` exists after the rollback completes

#### Scenario: Opting out leaves files on disk but uncommitted
- **WHEN** `commitRunArtifacts` is set to `false`
- **THEN** no additional commit is made, `transcript.jsonl`/`metrics.json`/`summary.md` still exist on disk with current data, and the run's log output names their path explicitly

### Requirement: SIGINT and SIGTERM preserve run data without rolling back the working tree

The agent loop SHALL register `SIGINT` and `SIGTERM` handlers, prepended ahead of any other process-level signal listener, that run fully synchronously. On receiving either signal, the loop SHALL NOT roll back or modify tracked working-tree files; it SHALL write a final synchronous `metrics.json` snapshot and, when `commitRunArtifacts` is `true`, make a commit of only the run-artifact files before exiting with code `130`.

#### Scenario: Ctrl-C mid-run preserves completed work and exits promptly
- **WHEN** a user sends `SIGINT` during an in-flight turn
- **THEN** the process exits promptly with code `130`, the working tree's design files are unchanged from the moment of interrupt, and a commit exists containing only that run's artifact files

#### Scenario: The interactive renderer's own terminal-restore behavior is unaffected
- **WHEN** `SIGINT` arrives during an interactive-mode run
- **THEN** the terminal cursor and status line are still restored (the existing `InteractiveRenderer` behavior), in addition to this change's artifact commit
