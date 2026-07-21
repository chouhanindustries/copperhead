# run-observability — delta spec

## ADDED Requirements

### Requirement: Run metadata is collected before the first agent turn

The agent loop SHALL collect a structured metadata block deterministically (no LLM calls, no network beyond local subprocesses) after config load and before the first provider call. The block SHALL contain: copperhead version and install path; `kicad-cli` version; Node version; OS platform; model id, provider name, and model-selection source (one of `flag`, `env`, `config`, `openai-key`, `anthropic-key`); run id and ISO-8601 start timestamp; command (`do`, `create`, or `sync`); for `create`, the stage name, stage position (`index`/`total`), and brief path with SHA-256 content hash; interactive vs autonomous mode; the resolved config snapshot (`schematic`, `board`, `docs`, `maxTurns` as applied to this run, `maxRepairCycles`, `budgets` verbatim); git commit, branch, dirty flag with uncommitted-file count; whether the copperhead pre-commit hook is installed; and counts of open constraints and prior runs.

#### Scenario: Metadata reflects the resolved run, not just the config file

- **WHEN** `copperhead do "x" --max-turns 12` runs in a repo whose config sets `maxTurns: 40`
- **THEN** the collected metadata reports the effective turn budget `12`, and the model-selection source names the actual winner of flag > `COPPERHEAD_MODEL` > config > available-key precedence

#### Scenario: Unconfigured schematic is visible

- **WHEN** a run starts in a repo whose config has no `schematic` set
- **THEN** the metadata contains `schematic: null` (not an omitted key)

#### Scenario: A failed probe degrades to null instead of failing the run

- **WHEN** one environment probe errors (e.g. `git` cannot report a branch)
- **THEN** that field is `null`, every other field is populated, and the run proceeds normally

### Requirement: Metadata is written to all three surfaces from one source

The loop SHALL render the single collected metadata object onto three surfaces: (1) the `run-start` event in `transcript.jsonl` carrying the complete block, (2) an `## Environment` section in `summary.md`, and (3) a CLI header of at most two lines printed before the first turn showing at minimum copperhead version, model and provider with selection source, stage (when in a `create` pipeline), and turn budget. The existing `run-start` fields `request`, `model`, and `provider` SHALL remain present under their current names.

#### Scenario: run-start event carries the full block

- **WHEN** any agent-loop run starts
- **THEN** the first `run-start` event in `transcript.jsonl` contains the complete metadata block, including `request`, `model`, and `provider` under their existing names

#### Scenario: summary.md gains an Environment section

- **WHEN** a run ends by any path (success, refusal, or failure)
- **THEN** `summary.md` contains an `## Environment` section whose values match the `run-start` event

#### Scenario: CLI header appears before the first turn

- **WHEN** `copperhead create` executes a pipeline stage
- **THEN** before the stage's first turn the CLI prints a header including the copperhead version, model with provider and selection source, the stage as `name (k/N)`, and the turn budget

### Requirement: Post-run addenda are recorded on every terminal path

At every terminal branch the loop SHALL emit a `run-end` event to `transcript.jsonl` and render a `## Run stats` section in `summary.md`, both containing: exit path (`done`, `refused`, `turn-budget-exhausted`, `repair-cycles-exhausted`, `commit-failed`, `provider-error`, or `stalled`), turns used vs turn budget, repair cycles used vs `maxRepairCycles`, tokens in/out totals with a per-turn breakdown, and wall-clock duration. The CLI SHALL print a final outcome line with the exit path, verification status, commit (when one was made), duration, and token totals.

#### Scenario: Successful run records its stats

- **WHEN** a run commits successfully
- **THEN** the `run-end` event and `## Run stats` report `exitPath: done`, turns used vs budget, tokens with per-turn rows, and duration, and the CLI prints one outcome line containing the commit hash

#### Scenario: Budget exhaustion is machine-readable

- **WHEN** a run hits its turn budget without finishing
- **THEN** the `run-end` event and summary report `exitPath: turn-budget-exhausted` with `turnsUsed` equal to the budget

### Requirement: Commit failure is a reported outcome, not a crash

The loop SHALL catch failures of the final commit, roll back per the existing snapshot contract, and record the run with exit path `commit-failed` in the transcript, `summary.md`, and CLI output, including the git error text in the summary detail. A failure of the subsequent archive commit — after the verified run commit already exists — SHALL also be caught (never an unhandled throw) and recorded in the transcript and CLI output as a warning, without discarding the verified commit or changing the run's exit path.

#### Scenario: git commit exits non-zero

- **WHEN** the end-of-run `git` commit fails (e.g. an embedded repository makes `git add -A` exit 128)
- **THEN** the run ends with `exitPath: commit-failed`, `summary.md` is still written and names the outcome with the git error text, and no unhandled stack trace reaches the user

### Requirement: Live progress output shows position against the turn budget and token usage

During the loop the CLI SHALL surface, continuously, the current turn number, the turn budget, and cumulative token usage for the run so far (e.g. `turn 7/40 · 12.3k in / 4.1k out`), and SHALL keep tool-call results to one line each as today. In plain (non-interactive) mode this SHALL take the form of a `[turn k/N · <in> in / <out> out]` prefix on each turn's output.

#### Scenario: Turn marker carries counter and cumulative tokens

- **WHEN** a run in plain mode is on its 7th turn of a 40-turn budget having consumed 12,300 input and 4,100 output tokens so far
- **THEN** the live output for that turn begins with a `[turn 7/40 · 12.3k in / 4.1k out]` marker

### Requirement: Output is interactive on a TTY and plain otherwise

When stdout is a TTY and neither `--json` nor `--plain` is set, the CLI SHALL render progress interactively: a persistent status line pinned to the bottom of the terminal, redrawn in place, showing a spinner while a provider call is in flight plus elapsed time, turn counter vs budget, and cumulative tokens; assistant text and tool results SHALL print above it so the scrollback remains a complete log, and the final outcome line SHALL replace the status line. A renderer SHALL survive its run's end: each run's outcome line releases the status line and restores the cursor, and a later run reusing the same renderer (the `create` pipeline's next stage) re-establishes it, so every stage of a multi-run command renders. When stdout is not a TTY, or `--json` is set, or the global `--plain` flag is passed, the CLI SHALL emit plain line-oriented output containing no ANSI escape codes; with `--json`, progress SHALL go to stderr so stdout carries only the machine-readable result. The interactive renderer SHALL restore the cursor and clear its status line on exit, including on SIGINT.

#### Scenario: Interactive status line on a TTY

- **WHEN** a run executes with stdout attached to a TTY and without `--json`
- **THEN** a status line showing spinner, elapsed time, turn counter vs budget, and cumulative tokens is updated in place at the bottom of the output, and the run's final outcome line replaces it

#### Scenario: Piped output stays plain

- **WHEN** a run's stdout is piped (not a TTY) or `--json` is set
- **THEN** the output is line-oriented with per-turn `[turn k/N · …]` markers and contains no ANSI escape sequences

#### Scenario: --json keeps stdout machine-readable

- **WHEN** a command runs with `--json` and its loop emits progress (header, turn markers, tool results, outcome line)
- **THEN** all progress lines are written to stderr and stdout contains only the command's JSON output

#### Scenario: A reused renderer renders every pipeline stage

- **WHEN** `create` runs interactively and its first stage ends with an outcome line
- **THEN** the second stage's header, status line, and outcome line still render through the same renderer

#### Scenario: --plain forces log-style output on a TTY

- **WHEN** a run executes on a TTY with the global `--plain` flag
- **THEN** the output is the same line-oriented, ANSI-free log format as piped output, with no status line or in-place redraws

#### Scenario: Terminal state restored on interrupt

- **WHEN** the user presses Ctrl-C during an interactive run
- **THEN** the cursor is visible and the status line is cleared before the process exits

### Requirement: Metadata surfaces are redacted at write time

All metadata and addenda written to `transcript.jsonl` and `summary.md` SHALL pass through the existing secret redaction, so a secret matching `sk-[A-Za-z0-9_-]+` appearing in any metadata field is redacted.

#### Scenario: Secret in an environment-derived field

- **WHEN** a metadata field value contains a string matching `sk-...`
- **THEN** the persisted `run-start` event and `summary.md` show the redacted placeholder, not the key
