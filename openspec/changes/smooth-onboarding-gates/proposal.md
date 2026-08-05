# smooth-onboarding-gates: Proposal

## Why

Copperhead's git gates are correct and its error messages already explain the fix. They still stop a user cold at three of the most common first moments: an empty directory, no brief file, and a working tree with uncommitted work. Every one of those refusals ends with instructions the tool could carry out itself, after asking.

`copperhead create` is the first command most new users run, and it is the one most likely to be run in a directory they just made. Two things stop them there:

1. **The git gate.** The pipeline's snapshot/rollback needs a repository with at least one commit, so `create` refused with a preflight error telling the user to run `git init` and commit by hand. The advice is correct and the friction is pointless: `create` is going to write the repository's entire history anyway, so it can prepare the repo itself.
2. **The brief file.** `--brief <file>` was required, so trying copperhead meant first opening an editor and writing a markdown file. The pipeline stage-1 prompt happily accepts a sentence; the file requirement was an artifact of how the brief is hashed and referenced in the resume command, not a real constraint on the input.

## What Changes

- **`create` accepts the brief as a positional argument**: `copperhead create "a 4-key USB-C macro keypad"`. Text is materialized into a real markdown file in the repo (`brief.md`, or the next free `brief-N.md`) before the pipeline starts, so run metadata, the brief sha256, and the printed resume command work exactly as they do in file mode. An existing brief is never overwritten; one with identical content is reused, so re-running the same one-liner resumes instead of littering. A positional argument that names an existing `.md`/`.markdown`/`.txt` file is treated as that file, so `create brief.md` also works.
- **`--brief <file>` becomes optional** and keeps its current meaning. Invoking `create` with neither form exits non-zero with a usage line showing both.
- **`create` prepares git instead of refusing over it**: `git init` when there is no repository, the baseline `.gitignore` (`.env`, `.copperhead/runs/`, `.history/`) before any commit (AC-4.3), a repo-local git identity when none is configured, and the initial commit that stage rollbacks snapshot against. In a repository that already has commits, nothing is initialized and the only commit made is the brief itself, so a stage rollback (`git reset --hard` + `git clean -fd`) cannot delete the file the resume command points at.
- **`do`, `repl`, and `sync` keep the strict `gitPreflight`** for the repo and unborn-HEAD gates. Those edit a repository the user already owns, where an implicit initial commit would be a surprise rather than a convenience.
- **The dirty-tree gate becomes a question on attended runs.** Instead of only describing the three fixes, `do`, `sync`, and the interactive shell list the uncommitted files and offer them: commit the work, stash it, run anyway (`--allow-dirty` semantics), or cancel. Cancelling, a prompt that throws, and every unattended run (no TTY, or `--json`) fall through to the existing refusal, so the protection AC-3.8 describes is unchanged wherever there is nobody to ask.

## Capabilities

### Modified Capabilities

- `cli-surface`: `create` takes the brief positionally as text or a path; `--brief` is optional.
- `create-pipeline`: brief materialization and the git preparation step that runs before stage 1.
- `safety-rails`: the dirty-tree gate gains an attended resolution path; the unattended refusal is unchanged.

## Impact

- **Code**: `src/util/git.ts` gains `ensureGitReady`, `commitPaths`, `dirtyFiles`, and `stashDirty`; new `src/util/dirty.ts` holds the choice set and applies it; `src/agent/loop.ts` gains an `onDirtyTree` chooser; `src/commands/create.ts` gains brief resolution and a `prepareGit` prologue; `src/commands/repl.ts` resolves the tree before a turn (its key reader is paused during one); `src/cli.ts` supplies the TTY menu and the positional brief argument.
- **Tests**: `test/create-setup.test.ts` (git preparation, brief materialization, no-overwrite, reuse) and `test/dirty-tree.test.ts` (each choice's effect on the tree, prompt failure reads as cancel, unattended refusal unchanged, `--allow-dirty` never asks); the two obsolete refusal cases in `test/preflight.test.ts` are removed, and the `do`-path gates there are untouched.
- **Docs**: README quick start, `docs/reference/cli.md`, `docs/workflows/create-from-brief.md`, SPEC §2.5 / §3 / §7 / AC-3.8 / AC-4.3.
- **Unchanged contracts**: `check` stays LLM-free and network-free; unattended runs refuse on a dirty tree exactly as before, and the repo/unborn-HEAD gates still hold for `do`/`repl`/`sync`; the spec-gated-in and verification-gated-out invariants are untouched.
