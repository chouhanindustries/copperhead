# safety-rails — Delta Spec

## MODIFIED Requirements

### Requirement: Git-state preconditions and rollback
`do` and `repl` SHALL refuse to start on a dirty git tree unless `--allow-dirty` is passed or the user resolves the tree at the attended prompt below, whose snapshot pairs a `git stash create` object for tracked changes with a tree object for the untracked-but-not-ignored files that `git stash create` cannot capture; on unrecoverable failure the working tree SHALL be restored to the pre-run snapshot, tracked and untracked alike.

#### Scenario: Dirty tree refusal (AC-3.8)
- **WHEN** the repo has uncommitted changes and `do` or `repl` runs unattended (no TTY, or `--json`) without `--allow-dirty`
- **THEN** it refuses to start and suggests `--allow-dirty`

#### Scenario: Untracked work survives a rollback (AC-3.8)
- **WHEN** a run started with `--allow-dirty` fails unrecoverably and the tree held untracked, non-ignored files before the run
- **THEN** the rollback restores those files along with the tracked modifications, and gitignored paths are neither captured nor disturbed

#### Scenario: Unsnapshottable untracked file refused
- **WHEN** a run starts with `--allow-dirty` and an untracked, non-ignored file exists that copperhead cannot read
- **THEN** it refuses to start, names the file, and explains that the rollback would delete it with nothing to restore it from

#### Scenario: Snapshot restore
- **WHEN** a run fails unrecoverably
- **THEN** `git status` is clean and all files are byte-identical to the pre-run state

## ADDED Requirements

### Requirement: Attended runs are offered a way through the dirty-tree gate
When an attended run (a TTY, without `--json`) meets the dirty-tree gate, copperhead SHALL name the uncommitted files and offer to commit them, stash them, run anyway, or cancel, and SHALL apply the choice before the run's snapshot is taken. Unattended runs SHALL keep refusing unchanged.

#### Scenario: Commit
- **WHEN** the user chooses to commit
- **THEN** the uncommitted paths are committed, the tree is clean, the run proceeds, and a later rollback returns to that commit rather than discarding the work

#### Scenario: Stash
- **WHEN** the user chooses to stash
- **THEN** the changes are stashed with untracked files included, the tree is clean, the run proceeds, and the run log states that `git stash pop` restores them

#### Scenario: Run anyway
- **WHEN** the user chooses to run anyway
- **THEN** the run proceeds with `--allow-dirty` semantics: nothing is committed or stashed, and the snapshot preserves the changes across a rollback

#### Scenario: Cancel
- **WHEN** the user cancels, or the prompt fails or is dismissed
- **THEN** the tree is left exactly as it was and the run refuses with the standard dirty-tree message and its fixes

#### Scenario: Unattended run
- **WHEN** the run has no TTY or was invoked with `--json`
- **THEN** no prompt is raised and the run refuses exactly as it did before (AC-3.8)

#### Scenario: Explicit opt-in skips the question
- **WHEN** the run was invoked with `--allow-dirty`
- **THEN** no prompt is raised and the run proceeds

#### Scenario: The prompt is only for the dirty gate
- **WHEN** the directory is not a git repository, or the repository has no commits
- **THEN** no prompt is raised and the preflight reports that specific failure with its own fix

### Requirement: Copperhead's own artifacts never count as the user's uncommitted work
The dirty-tree gate SHALL consider only paths copperhead did not write itself. The run audit trail under `.copperhead/runs/` SHALL be excluded from the dirty check by path, whether or not the repository's `.gitignore` lists it, and every commit copperhead makes SHALL top that entry up so the trail is never swept into project history.

#### Scenario: The session log does not block the session (AC-4.3)
- **WHEN** `do`, `sync`, or the REPL runs in a repository the user initialized by hand, whose `.gitignore` does not list `.copperhead/runs/`, and copperhead has written its session log or transcript there
- **THEN** the gate does not fire, no prompt is raised, and the run starts

#### Scenario: Real uncommitted work still stops the run
- **WHEN** the tree holds the user's own uncommitted changes alongside the run audit trail
- **THEN** the gate fires, and the files it names are the user's, with the audit trail absent from the list and from the count
