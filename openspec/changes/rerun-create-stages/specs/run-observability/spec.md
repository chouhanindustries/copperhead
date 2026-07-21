# run-observability — Delta Spec

## MODIFIED Requirements

### Requirement: Run metadata is collected before the first agent turn

The agent loop SHALL collect a structured metadata block deterministically (no LLM calls, no network beyond local subprocesses) after config load and before the first provider call. The block SHALL contain: copperhead version and install path; `kicad-cli` version; Node version; OS platform; model id, provider name, and model-selection source (one of `flag`, `env`, `config`, `openai-key`, `anthropic-key`); run id and ISO-8601 start timestamp; command (`do`, `create`, or `sync`); for `create`, the stage name, stage position (`index`/`total`), brief path with SHA-256 content hash, the stage's run trigger (one of `initial`, `requested`, `from`, `stale`), and — when the trigger is `stale` — the names of the changed upstream artifacts; interactive vs autonomous mode; the resolved config snapshot (`schematic`, `board`, `docs`, `maxTurns` as applied to this run, `maxRepairCycles`, `budgets` verbatim); git commit, branch, dirty flag with uncommitted-file count; whether the copperhead pre-commit hook is installed; and counts of open constraints and prior runs.

#### Scenario: Metadata reflects the resolved run, not just the config file

- **WHEN** `copperhead do "x" --max-turns 12` runs in a repo whose config sets `maxTurns: 40`
- **THEN** the collected metadata reports the effective turn budget `12`, and the model-selection source names the actual winner of flag > `COPPERHEAD_MODEL` > config > available-key precedence

#### Scenario: Unconfigured schematic is visible

- **WHEN** a run starts in a repo whose config has no `schematic` set
- **THEN** the metadata contains `schematic: null` (not an omitted key)

#### Scenario: A failed probe degrades to null instead of failing the run

- **WHEN** one environment probe errors (e.g. `git` cannot report a branch)
- **THEN** that field is `null`, every other field is populated, and the run proceeds normally

#### Scenario: A stale-triggered stage records why it re-ran

- **WHEN** the schematic stage re-runs because the recorded `bom` input hash no longer matches
- **THEN** the run's metadata stage block carries trigger `stale` and changed inputs `["bom"]`, on all three surfaces (run-start event, `summary.md ## Environment`, CLI header)
