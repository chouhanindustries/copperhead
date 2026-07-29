# Tasks: smooth-onboarding-gates

## 1. Git preparation

- [x] 1.1 Add `ensureGitReady` to `src/util/git.ts`: init when absent (`-b main`, falling back for git < 2.28), baseline `.gitignore` (`.env`, `.copperhead/runs/`, `.history/`), repo-local identity fallback, `--allow-empty` initial commit; no-op past the `.gitignore` top-up once the repo has commits
- [x] 1.2 Add `commitPaths` (pathspec commit) so the brief can be committed without sweeping up the user's other dirty or staged paths
- [x] 1.3 Call it from a `prepareGit` prologue in `runCreate`, logging what was done and why; leave `gitPreflight` as the gate for `do` / `repl` / `sync`

## 2. Brief input

- [x] 2.1 `resolveBriefPath`: `--brief` wins; a positional `.md`/`.markdown`/`.txt` argument naming an existing file is used as-is; anything else is brief text
- [x] 2.2 `materializeBriefText`: write to `brief.md`, fall back to the next free `brief-N.md`, reuse a byte-identical existing brief, refuse empty text
- [x] 2.3 Make `briefPath` optional on `CreateOptions`, add `briefText`, resolve once at the top of `runCreate` so metadata, the brief sha256, and the resume command all read the same path

## 3. CLI

- [x] 3.1 `create` takes `[brief]` positionally; `--brief` is no longer a required option
- [x] 3.2 Neither form given: exit non-zero with a usage line showing both

## 4. Dirty-tree gate

- [x] 4.1 `src/util/git.ts`: `dirtyFiles` (porcelain parse, rename-aware) and `stashDirty` (`stash push -u`), reusing `commitAll` for the commit path
- [x] 4.2 New `src/util/dirty.ts`: the four choices, the capped file list, and `resolveDirtyTree`, which applies the choice and reports whether the run continues under `--allow-dirty`; a thrown or dismissed prompt reads as cancel
- [x] 4.3 `runAgentLoop` takes an `onDirtyTree` chooser and resolves before `gitPreflight`; absent chooser keeps the refusal (AC-3.8)
- [x] 4.4 `src/cli.ts`: TTY-only `selectMenu` chooser wired into `do` and `sync`, suppressed under `--json`
- [x] 4.5 REPL: resolve before the turn (its key reader is paused during one), passing a per-turn `allowDirty` override through the runner
- [x] 4.6 Exclude copperhead's own `.copperhead/runs/` from the dirty check by path (`git status --porcelain -uall`, so a wholly-untracked `.copperhead/` is not collapsed into one unfilterable entry); make `isDirty` and `uncommittedCount` derive from `dirtyFiles` so the gate, its file list, and `/git` cannot disagree; add `.copperhead/runs/` to `GIT_ADD_EXCLUDES` so every copperhead commit tops the ignore entry up

## 5. Tests

- [x] 5.1 `test/create-setup.test.ts`: non-git directory, unborn HEAD, empty directory, existing-history repo (only the brief is committed, the user's unrelated file is not), `ensureGitReady` idempotence
- [x] 5.2 Brief materialization: text written verbatim and carried into the stage prompt, identical text reused, different text never overwriting, positional path used as a file, empty text refused, missing `--brief` file named in the error
- [x] 5.3 `test/dirty-tree.test.ts`: each choice's effect on the tree and history, a thrown prompt reading as cancel, a clean tree never asking, the repo/unborn-HEAD gates never prompting, the file-list cap, plus in-loop coverage (no chooser refuses, cancel refuses, commit proceeds, `--allow-dirty` never asks)
- [x] 5.4 Remove the two obsolete `create` refusal cases from `test/preflight.test.ts`; the `do`-path gates there stay untouched
- [x] 5.5 `test/preflight.test.ts`: a hand-initialized repo with no copperhead ignores and a written session log passes the gate, while the user's own uncommitted file still refuses and is the only path named
- [x] 5.6 `test/dirty-tree.test.ts`: `dirtyFiles` names paths in full for every porcelain status column (` M`, `??`, staged rename)
- [x] 5.7 `test/repl.test.ts`: the two session-log tests wait on the turn starting instead of a fixed 30ms sleep, which the new pre-turn git probe made too tight

## 6. Docs

- [x] 6.1 README quick start: the empty-directory one-liner
- [x] 6.2 `docs/reference/cli.md`: both brief forms, a git-setup section covering what `create` does and why `do`/`sync` differ, and the uncommitted-changes table under `do`
- [x] 6.3 `docs/workflows/create-from-brief.md`: one-liner section, and drop the manual `git init && git commit --allow-empty` step
- [x] 6.4 SPEC.md: §2.5 inputs, §3 command list, §7 safety rails (both gates), AC-3.8 attended resolution, AC-4.3 note about the repo `create` initializes
