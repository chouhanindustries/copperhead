# create-pipeline — Delta Spec

## ADDED Requirements

### Requirement: create prepares the git repository it needs
Before stage 1 runs, `create` SHALL bring the target directory to the state the pipeline's snapshot and rollback require, rather than refusing over a missing one. `do`, `repl`, and `sync` SHALL keep the strict preflight (AC-3.8) unchanged.

#### Scenario: Non-git directory
- **WHEN** `create` is run in a directory that is not a git repository
- **THEN** it runs `git init`, writes a `.gitignore` containing `.env`, `.copperhead/runs/`, and `.history/`, creates the initial commit, and proceeds to stage 1
- **AND** the run log states that a repository was initialized and why

#### Scenario: Repository with an unborn HEAD
- **WHEN** `create` is run in a repository that has no commits
- **THEN** it creates the initial commit and proceeds, without re-initializing the repository

#### Scenario: Empty directory
- **WHEN** `create` prepares a directory that contains no files
- **THEN** an empty initial commit is created, so a stage rollback still has a snapshot to restore to

#### Scenario: No git identity configured
- **WHEN** the commit is needed and neither `user.name` nor `user.email` is configured
- **THEN** a repo-local identity is written, the global git config is not modified, and the run log names the identity used

#### Scenario: Repository that already has commits
- **WHEN** `create` is run in a repository with existing history
- **THEN** no repository is initialized, no identity is written, and no existing commit is altered

#### Scenario: Secrets never enter the first commit
- **WHEN** `create` initializes a repository and creates its initial commit
- **THEN** the baseline `.gitignore` is written before that commit, so `.env` and `.copperhead/runs/` are ignored from the very first commit (AC-4.3)

### Requirement: The brief exists as a committed file
`create` SHALL run against a brief that exists as a file inside the repository whenever the brief was given as text, and SHALL commit that file before stage 1.

#### Scenario: Text brief is materialized
- **WHEN** the brief is given as text
- **THEN** it is written verbatim to `brief.md` in the repo root, and the run's brief path and sha256 metadata refer to that file

#### Scenario: An existing brief is never overwritten
- **WHEN** the brief is given as text and `brief.md` exists with different content
- **THEN** the text is written to the next free `brief-N.md` and the existing file is left untouched

#### Scenario: Re-running the same text reuses the brief
- **WHEN** the brief is given as text identical to an existing brief file's content
- **THEN** that file is reused, no new file is written, and completed stages are skipped as on any other resume

#### Scenario: Empty text
- **WHEN** the brief text is empty or whitespace only
- **THEN** the run is refused with a message naming both input forms, and no brief file is written

#### Scenario: Brief survives a stage rollback
- **WHEN** a stage fails and the tree is rolled back with `git reset --hard` and `git clean -fd`
- **THEN** the brief file is still present, because it was committed before stage 1, and the printed resume command resolves
