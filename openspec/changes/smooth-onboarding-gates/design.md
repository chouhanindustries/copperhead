# smooth-onboarding-gates: Design

## Context

The create pipeline's safety model rests on git: each stage snapshots HEAD, and a stage that fails its gate is rolled back with `git reset --hard` + `git clean -fd`. That made "a repo with at least one commit" a hard precondition, enforced by `gitPreflight` and surfaced to first-time users as a refusal. The brief, meanwhile, has to exist as a file because run metadata records its path and sha256 and the resume line prints `--brief <abs path>`.

Both requirements are real. Neither has to be the *user's* job on the create path.

## Goals / Non-Goals

**Goals:**

- `mkdir board && cd board && copperhead create "<sentence>"` works, with no git or file setup first.
- Text mode and file mode converge on one artifact, so resume, run metadata, and the brief hash have exactly one code path.
- Nothing about the rollback guarantee weakens.

**Non-Goals:**

- Loosening the git gates for `do` / `repl` / `sync`.
- Interpreting or reformatting the user's brief text (no LLM in the setup path; the text is written verbatim).
- Auto-committing a user's unrelated working changes.

## Decisions

- **D1: `create` prepares git; `do` and `sync` refuse.** The split is about ownership. `create` authors a repository from nothing, so initializing it is part of the job. `do` edits a repo the user already owns, where an implicit `git add -A && git commit` could sweep up work the user never meant to commit. `ensureGitReady` is therefore a separate export from `gitPreflight` rather than a flag on it, and only `create` calls it. Alternative considered: an `--init` flag on `create`. Rejected: a flag you have to discover after a refusal fixes nothing for the person who just hit the refusal.
- **D2: `ensureGitReady` never touches a repo that has commits.** Its only work on that path is the idempotent `.gitignore` top-up. Everything else (init, identity fallback, initial commit) is gated on the states that would otherwise refuse the run, so running `create` inside an existing project cannot rewrite or add to history unexpectedly.
- **D3: The initial commit is `--allow-empty` with `git add -A`.** In an empty directory there is nothing to stage, and the point of the commit is to be a rollback anchor, not to carry content. In a directory with files, committing them is the honest thing to do: the pipeline is about to start rolling the tree back to this point, and an untracked file that a rollback would delete is worse than a tracked one.
- **D4: A repo-local git identity fallback, not a failure.** `git commit` hard-fails without `user.name`/`user.email`, which is exactly the state of a fresh machine. Writing `copperhead <copperhead@localhost>` into the repo's own config keeps the run moving without touching the user's global config, and the run log says it happened so they can override it.
- **D5: Text briefs are materialized, not held in memory.** A file is what makes the run resumable (`resumeCommand` prints `--brief <path>`) and auditable (per-stage brief sha256, AC-8.1). Materializing keeps one artifact and one code path for both input forms.
- **D6: Never overwrite a brief; reuse an identical one.** Numbered fallbacks (`brief-2.md`, …) mean a second one-liner in the same directory cannot destroy the first. Reusing a byte-identical existing brief means the common case — rerunning the same command to resume after a stopped stage — does not litter the directory with copies. Alternative considered: refuse when `brief.md` exists. Rejected: it turns the resume path into an error.
- **D7: The brief is committed before stage 1.** Otherwise the first failing stage's rollback (`git clean -fd`) deletes the untracked brief the printed resume command points at, which is precisely the moment the user needs it. `commitPaths` uses a pathspec commit so only the brief is committed, leaving any other dirty or staged path alone.
- **D8: The dirty-tree gate asks instead of refusing, but only when someone is there.** The gate's reasoning (a rollback would destroy uncommitted work) is not weakened by asking; it is weakened by guessing. So the chooser is an injected callback: present on a TTY, absent under `--json`, in CI, and in pipes, where the run refuses exactly as it always did. A prompt that throws or is dismissed reads as cancel, never as consent.
- **D9: The choices are the ones the refusal message already recommends.** Commit, stash, run anyway, cancel. Inventing a fourth recovery story would mean new behavior to explain and test; these three are already documented and are what a user does by hand after the refusal today.
- **D10: The REPL resolves before the turn, not inside it.** The shell pauses its raw-mode key reader for the duration of an agent turn (so Ctrl+C is a real SIGINT), so a menu raised from inside `runAgentLoop` would never see a keypress. The shell therefore resolves the tree while its reader is live and passes the result as a per-turn `allowDirty` override; `do` and `sync`, which have no such reader, use the loop's `onDirtyTree` callback directly.
- **D11: Commit is the recommended choice, and it is reversible.** Of the three, only "run anyway" leaves the work exposed to any later mistake, and only "commit" survives a rollback with zero further steps. A commit the user did not want is `git reset --soft HEAD~1` away, which is the cheapest failure mode of the four.

## Risks / Trade-offs

- **`git init` in an unexpected directory.** A user could run `create` in the wrong place and get a repository where they did not want one. Mitigated by it being non-destructive (no file content changes; `rm -rf .git` undoes it), by the run log naming what happened, and by the operation being skipped entirely inside any existing repo, including a subdirectory of one.
- **The initial commit can include pre-existing files.** In a non-empty, non-git directory the anchor commit stages everything present. This is deliberate (D3): those files would otherwise be destroyed by the first rollback. The baseline `.gitignore` is written first, so `.env` is never in that commit (AC-4.3).
- **A prompt in the middle of a session.** The dirty-tree menu is raised before an agent turn, inside the shell's alternate screen. It uses the same picker as `/model`, so the rendering path is proven, but a terminal that mishandles it would show a rough menu rather than a broken run: cancel and dismissal both land on the existing refusal.
- **A brief that is gitignored cannot be committed.** `commitPaths` failure is caught and logged as a warning rather than failing the run; the pipeline continues, with the (documented) consequence that a rollback may remove that file.
