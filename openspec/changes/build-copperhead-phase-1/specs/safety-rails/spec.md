# safety-rails — Delta Spec

## ADDED Requirements

### Requirement: Path sandboxing
All file tools SHALL resolve paths relative to the repo root and reject any path escaping it; no network tools exist in Phase 1.

#### Scenario: Traversal rejected (AC-4.2)
- **WHEN** a tool call targets a path outside the repo root (e.g. `../../etc/hosts`)
- **THEN** the call is rejected with an error and no file outside the repo is read or written

### Requirement: Git-state preconditions and rollback
`do` SHALL refuse to start on a dirty git tree unless `--allow-dirty` is passed (which snapshots via `git stash create`); on unrecoverable failure the working tree SHALL be restored to the pre-run snapshot by default. With explicit `--keep-on-fail`, restoration and cleaning SHALL be skipped while all success, verification, obligations, and commit gates remain unchanged; the dirty tree SHALL therefore still be refused by the next default run.

#### Scenario: Dirty tree refusal (AC-3.8)
- **WHEN** the repo has uncommitted changes and `do` runs without `--allow-dirty`
- **THEN** it refuses to start and suggests `--allow-dirty`

#### Scenario: Snapshot restore
- **WHEN** a run fails unrecoverably
- **THEN** `git status` is clean and all files are byte-identical to the pre-run state

#### Scenario: Explicit failed-tree preservation
- **WHEN** an unrecoverable failure occurs with `--keep-on-fail`
- **THEN** no restore or clean runs, no failure commit is created, and the warning and run summary identify rollback as skipped and provide the snapshot refs plus a manual recovery command

#### Scenario: Dirty snapshot recovery is complete
- **WHEN** `--allow-dirty` and `--keep-on-fail` are used together
- **THEN** the warning and summary show both the pre-run HEAD and stash object, and the recovery recipe resets and cleans before applying the stash object

### Requirement: Secret hygiene
API keys SHALL exist only in environment variables; `.env` and `.copperhead/runs/` SHALL be in `.gitignore` from the first commit; transcripts SHALL redact anything matching `sk-[A-Za-z0-9_-]+` at write time.

#### Scenario: No keys anywhere (AC-4.1)
- **WHEN** the full test suite has run
- **THEN** no file in the repo tree, transcripts, or any commit matches `sk-[A-Za-z0-9_-]{20,}`

#### Scenario: gitignore from first commit (AC-4.3)
- **WHEN** the repo's first commit is inspected
- **THEN** `.gitignore` already includes `.env` and `.copperhead/runs/`

### Requirement: No invented part numbers
The agent SHALL never present an MPN as verified: any newly introduced part MUST carry a datasheet-verifiable justification in BOM.md and be flagged `UNVERIFIED` for human review.

#### Scenario: New part flagged
- **WHEN** a run adds a part not previously in the BOM
- **THEN** its BOM.md row includes an `UNVERIFIED` flag and a one-line justification

### Requirement: Honest completion claims
The agent SHALL never claim a design is fab-ready beyond "ERC/DRC clean"; refusals of budget-violating requests SHALL cite the documented budget rather than silently complying.

#### Scenario: No overclaim
- **WHEN** a run finishes with all checks green
- **THEN** the report states ERC/DRC-clean status without asserting fab-readiness or engineer sign-off

### Requirement: Run transcripts
Every `do`/`create` run SHALL write a transcript (audit trail) under `.copperhead/runs/`, and failure output SHALL include the transcript path.

#### Scenario: Transcript on failure
- **WHEN** a run exits non-zero
- **THEN** the transcript file exists under `.copperhead/runs/` and its path was printed

### Requirement: Human-readable run summary
Every run SHALL write a `summary.md` beside its JSONL transcript containing the request, OpenSpec change id, plan, files touched, ERC/DRC results, decisions made, and token usage — subject to the same secret redaction as the transcript.

#### Scenario: Summary written on completion
- **WHEN** a run finishes (success or failure)
- **THEN** `.copperhead/runs/<ts>/summary.md` exists and states the request, verification results, and files touched in prose a human can read without tooling

#### Scenario: Summary is redacted
- **WHEN** the summary is written
- **THEN** it contains no string matching `sk-[A-Za-z0-9_-]{20,}`
