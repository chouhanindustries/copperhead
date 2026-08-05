import { execa } from 'execa';
import { access, constants, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PreflightError } from './preflight.js';

/**
 * Paths copperhead must keep out of `git add -A`. Two kinds live here:
 *
 * KiCad ≥9 writes a git-backed local-history directory (`.history/`, complete
 * with its own nested `.git`) into the project the first time kicad-cli touches
 * it. Left untracked, that nested repo has an unborn HEAD, so a plain `git add
 * -A` in the parent aborts with `error: '.history/' does not have a commit
 * checked out` (exit 128) — which fails the commit at the end of every
 * KiCad-touching stage (schematic, layout, outputs). Ignoring it is both
 * correct (local history is never a project artifact) and the fix for that
 * abort.
 *
 * `.copperhead/runs/` is the run audit trail, which AC-4.3 requires every
 * copperhead repo to ignore. Topping it up here means a repo the user created
 * by hand (`git init && git commit`, no copperhead .gitignore) gets the entry
 * on the first commit copperhead makes, instead of having its transcripts
 * swept into project history.
 */
const GIT_ADD_EXCLUDES = ['.copperhead/runs/', '.history/'];

/**
 * Paths copperhead writes itself, which the dirty-tree gate must never count as
 * the user's uncommitted work.
 *
 * The gate exists because a rollback hard-resets over uncommitted changes — but
 * the run audit trail is not the user's work, and restore() deliberately copies
 * it across a rollback rather than destroying it. Counting it made copperhead
 * refuse to run over a file copperhead had just written: the REPL opens its
 * session log under `.copperhead/runs/` before the first turn, so in a repo
 * whose .gitignore does not yet list it (anyone who ran `git init` themselves)
 * the very first request hit the dirty gate with `.copperhead/` as the only
 * dirty path. Filtered by path rather than by .gitignore state, so the gate
 * behaves the same before and after the ignore entry lands.
 */
const OWN_ARTIFACTS = ['.copperhead/runs/'];

/** Whether a `git status` path is copperhead's own bookkeeping, not user work. */
function isOwnArtifact(p: string): boolean {
  return OWN_ARTIFACTS.some((prefix) => p === prefix || p.startsWith(prefix));
}

/**
 * Ensure the repo's root .gitignore lists each entry, appending only the
 * missing ones. Idempotent and best-effort: a failure here must never block a
 * commit, so it swallows its own errors. Run before any `git add -A` so a
 * git-backed KiCad `.history/` (or similar nested repo) is skipped instead of
 * aborting the add.
 */
export async function ensureIgnored(repo: string, entries: string[]): Promise<void> {
  try {
    const p = path.join(repo, '.gitignore');
    const text = existsSync(p) ? await readFile(p, 'utf8') : '';
    const present = new Set(text.split('\n').map((l) => l.trim()));
    const missing = entries.filter((e) => !present.has(e));
    if (!missing.length) return;
    const prefix = text.length && !text.endsWith('\n') ? '\n' : '';
    await writeFile(p, text + prefix + missing.join('\n') + '\n', 'utf8');
  } catch {
    // best-effort: .gitignore maintenance must never be the thing that fails a run
  }
}

export interface GitSnapshot {
  head: string;
  stash: string | null;
  /**
   * Tree object holding the untracked-but-not-ignored files that `git stash
   * create` cannot capture. Without it a rollback's `git clean -fd` deletes
   * them for good; see snapshotUntracked().
   */
  untracked: string | null;
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', args, { cwd: repo });
  return stdout.trim();
}

/** Same as git(), without the trim: for output whose leading whitespace matters. */
async function gitRaw(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', args, { cwd: repo });
  return stdout;
}

/** Same as git(), with a scratch index so the repo's real index is untouched. */
async function gitWithIndex(repo: string, indexFile: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', args, {
    cwd: repo,
    env: { GIT_INDEX_FILE: indexFile },
  });
  return stdout.trim();
}

/** Monotonic suffix so two scratch indexes in one process never collide. */
let scratchIndexSeq = 0;

/**
 * Path for a throwaway index, inside the repo's own git dir rather than
 * TMPDIR: git guarantees that directory exists and is writable, so a hostile
 * or missing temp dir cannot make a snapshot fail and block a run from
 * starting. Absolute, because git resolves GIT_INDEX_FILE against cwd.
 */
async function scratchIndexPath(repo: string): Promise<string> {
  const gitDir = await git(repo, ['rev-parse', '--absolute-git-dir']);
  return path.join(gitDir, `copperhead-index-${process.pid}-${scratchIndexSeq++}`);
}

/**
 * Write the untracked-but-not-ignored files to a tree object and return its
 * sha, or null when there are none.
 *
 * `git stash create` only ever captures tracked changes, so on its own it
 * leaves every new file a run (or the user) has not added yet outside the
 * snapshot — and restore()'s `git clean -fd` then deletes exactly those. The
 * two sets line up: `--exclude-standard` skips ignored paths and plain
 * `clean -fd` (no -x) leaves them alone, so what is captured here is precisely
 * what the rollback would otherwise destroy.
 *
 * Built through a scratch GIT_INDEX_FILE rather than `git add -A`, because
 * this runs at the *start* of a run: staging the user's files would outlive a
 * successful run and silently rewrite their staged/unstaged split.
 */
async function snapshotUntracked(repo: string): Promise<string | null> {
  const listed = await git(repo, ['ls-files', '--others', '--exclude-standard', '-z']);
  const paths = listed.split('\0').filter(Boolean);
  if (!paths.length) return null;
  const usable = await readableOnly(repo, paths);
  if (!usable.length) return null;
  const indexFile = await scratchIndexPath(repo);
  try {
    await execa('git', ['update-index', '-z', '--add', '--stdin'], {
      cwd: repo,
      env: { GIT_INDEX_FILE: indexFile },
      input: usable.join('\0') + '\0',
    });
    return (await gitWithIndex(repo, indexFile, ['write-tree'])) || null;
  } catch (err) {
    // A path that passed the readability check above and still failed here
    // lost the race (permissions or existence changed in between). Same
    // refusal, since the same file would be destroyed by the rollback.
    throw unsnapshottable(String((err as Error).message).split('\n')[0] ?? 'unknown path');
  } finally {
    await rm(indexFile, { force: true }).catch(() => {});
  }
}

/**
 * Drop untracked paths that no longer exist, and refuse on any that exist but
 * cannot be read.
 *
 * `git update-index` aborts the whole batch with exit 128 on the first path it
 * cannot open, and this runs before the first turn, so one stray root-owned or
 * mode-000 file would otherwise refuse every `--allow-dirty` run with a bare
 * `fatal: Unable to process path …`. A vanished path is dropped rather than
 * refused: a file that no longer exists cannot be lost. One that exists but is
 * unreadable is refused deliberately rather than skipped, because `restore()`'s
 * `git clean -fd` deletes it either way, and skipping would quietly reinstate
 * exactly the data loss the untracked snapshot exists to prevent.
 */
async function readableOnly(repo: string, paths: string[]): Promise<string[]> {
  const usable: string[] = [];
  for (const p of paths) {
    try {
      await access(path.join(repo, p), constants.R_OK);
      usable.push(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw unsnapshottable(p);
    }
  }
  return usable;
}

function unsnapshottable(what: string): PreflightError {
  return new PreflightError(
    `cannot read untracked file: ${what}`,
    'a run started with --allow-dirty promises your uncommitted work survives a failed run, but a file copperhead cannot read cannot be snapshotted, and the rollback would delete it with nothing to restore it from',
    [
      `make it readable: chmod +r "${what}"`,
      'or delete it, or add it to .gitignore so the rollback leaves it alone',
      'or commit your work and rerun without --allow-dirty',
    ],
  );
}

/**
 * Re-materialize the untracked files captured by snapshotUntracked(). Runs
 * after `stash apply` so tracked restores win any path collision.
 */
async function restoreUntracked(repo: string, tree: string): Promise<void> {
  const indexFile = await scratchIndexPath(repo);
  try {
    await gitWithIndex(repo, indexFile, ['read-tree', tree]);
    await gitWithIndex(repo, indexFile, ['checkout-index', '-a', '-f']);
  } finally {
    await rm(indexFile, { force: true }).catch(() => {});
  }
}

export async function isGitRepo(repo: string): Promise<boolean> {
  try {
    await git(repo, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

/** False on an unborn HEAD (fresh `git init` with no commits yet). */
export async function hasCommits(repo: string): Promise<boolean> {
  try {
    await git(repo, ['rev-parse', '--quiet', '--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

export async function isDirty(repo: string): Promise<boolean> {
  return (await dirtyFiles(repo)).length > 0;
}

/**
 * The user's uncommitted paths: staged, unstaged, and untracked, minus
 * copperhead's own artifacts (see OWN_ARTIFACTS). The single source of truth
 * for "is this tree dirty" — isDirty() is this list being non-empty, so the
 * gate and the file list it prints can never disagree.
 *
 * `-uall` lists untracked files individually instead of collapsing them into
 * the containing directory: `git status` reports a wholly-untracked
 * `.copperhead/` as one entry, which no per-file filter can see inside.
 */
export async function dirtyFiles(repo: string): Promise<string[]> {
  // Trailing-only trim, not git()'s .trim(): porcelain encodes the index and
  // worktree states in two leading columns, and an unstaged modification is
  // " M path" — a leading space. Trimming the whole payload ate that column on
  // the first line, so the prompt offered to commit "EADME.md" and any path
  // matched against it (the OWN_ARTIFACTS filter below) was off by a character.
  const status = (await gitRaw(repo, ['status', '--porcelain', '-uall'])).replace(/\n+$/, '');
  if (!status) return [];
  return status
    .split('\n')
    .map((line) => line.slice(3).trim())
    // Renames report "old -> new"; the new path is the one that exists.
    .map((p) => (p.includes(' -> ') ? p.split(' -> ')[1]!.trim() : p))
    .filter(Boolean)
    .filter((p) => !isOwnArtifact(p));
}

/**
 * Set the working tree aside as a stash entry, untracked files included, so
 * the tree is clean enough to run on and the work is one `git stash pop` away.
 */
export async function stashDirty(repo: string, message: string): Promise<boolean> {
  await ensureIgnored(repo, GIT_ADD_EXCLUDES);
  await git(repo, ['stash', 'push', '-u', '-m', message]);
  return !(await isDirty(repo));
}

/**
 * The run-blocking git gates, in order: repo -> commits -> dirty (AC-3.8).
 * Throws a PreflightError whose message explains why the run is refused and
 * how to fix it; a caller that catches only needs err.message.
 */
export async function gitPreflight(repo: string, opts: { allowDirty?: boolean } = {}): Promise<void> {
  if (!(await isGitRepo(repo))) {
    throw new PreflightError(
      'not a git repository; copperhead requires git for snapshots and rollback',
      'every run snapshots HEAD before editing so a failed run can be rolled back losslessly; without git there is no snapshot and no undo',
      ['git init', 'git add -A && git commit -m "initial commit"', 'rerun the same copperhead command'],
    );
  }
  if (!(await hasCommits(repo))) {
    throw new PreflightError(
      'repository has no commits; copperhead requires at least one commit for snapshots and rollback',
      'the pre-run snapshot is the current HEAD commit; with an unborn HEAD there is nothing to roll back to if verification fails',
      ['git add -A && git commit -m "initial commit"', 'rerun the same copperhead command'],
    );
  }
  if ((await isDirty(repo)) && !opts.allowDirty) {
    throw new PreflightError(
      'working tree is dirty; copperhead refuses to run on uncommitted changes by default',
      'a rollback hard-resets to the pre-run snapshot, which would silently destroy your uncommitted work',
      [
        'git add -A && git commit — to keep your changes (recommended)',
        'git stash — to set them aside for now',
        'or rerun with --allow-dirty to let copperhead preserve them via "git stash create"',
      ],
    );
  }
}

/**
 * What every copperhead repo must ignore from its first commit: secrets
 * (AC-4.3), the run audit trail, and KiCad's local-history directory.
 */
const BASELINE_IGNORES = [...new Set(['.env', ...GIT_ADD_EXCLUDES])];

export interface GitBootstrap {
  /** `git init` ran here. */
  initialized: boolean;
  /** A local user.name/user.email fallback was written (none was configured). */
  identityConfigured: boolean;
  /** An initial commit was created (the repo had an unborn HEAD). */
  committed: boolean;
}

/** Read a git config value, or null when unset. */
async function configValue(repo: string, key: string): Promise<string | null> {
  const res = await execa('git', ['config', '--get', key], { cwd: repo, reject: false });
  const value = res.exitCode === 0 ? res.stdout.trim() : '';
  return value.length ? value : null;
}

/**
 * Make a directory satisfy the git gates instead of refusing over them: init
 * the repo if there is none, write the baseline .gitignore, and create the
 * initial commit that snapshots/rollback need. Used by the pipeline commands,
 * where "you must set up git first" is pure friction for a new user — `do` and
 * `sync` keep the stricter gitPreflight, since those edit a repo the user
 * already owns and an implicit commit there would be a surprise.
 *
 * Never touches a repo that already has commits: on that path the only work is
 * the idempotent .gitignore top-up.
 */
export async function ensureGitReady(repo: string): Promise<GitBootstrap> {
  const result: GitBootstrap = { initialized: false, identityConfigured: false, committed: false };

  if (!(await isGitRepo(repo))) {
    await mkdir(repo, { recursive: true });
    // -b needs git >= 2.28; fall back so an older git still works.
    const named = await execa('git', ['init', '-q', '-b', 'main'], { cwd: repo, reject: false });
    if (named.exitCode !== 0) await git(repo, ['init', '-q']);
    result.initialized = true;
  }

  await ensureIgnored(repo, BASELINE_IGNORES);

  if (await hasCommits(repo)) return result;

  // `git commit` hard-fails without an identity, which on a fresh machine is
  // exactly the state a first-time user is in. A repo-local fallback keeps the
  // run moving without touching their global config.
  if (!(await configValue(repo, 'user.name'))) {
    await git(repo, ['config', 'user.name', 'copperhead']);
    result.identityConfigured = true;
  }
  if (!(await configValue(repo, 'user.email'))) {
    await git(repo, ['config', 'user.email', 'copperhead@localhost']);
    result.identityConfigured = true;
  }

  await git(repo, ['add', '-A']);
  // --allow-empty: an empty directory has nothing to stage, and the point of
  // the commit is the rollback anchor, not its contents.
  await git(repo, ['commit', '-q', '--allow-empty', '-m', 'chore: initialize repository for copperhead']);
  result.committed = true;
  return result;
}

/**
 * Commit exactly these paths, leaving anything else in the tree (and anything
 * already staged) alone: `git commit -- <path>` commits from the working tree
 * for those paths only. No-op when they hold nothing new.
 */
export async function commitPaths(repo: string, paths: string[], message: string): Promise<string | null> {
  if (!paths.length) return null;
  await git(repo, ['add', '--', ...paths]);
  const staged = await execa('git', ['diff', '--cached', '--quiet', '--', ...paths], { cwd: repo, reject: false });
  if (staged.exitCode === 0) return null; // nothing to commit for these paths
  await git(repo, ['commit', '-q', '-m', message, '--', ...paths]);
  return git(repo, ['rev-parse', 'HEAD']);
}

/**
 * Snapshot the working tree before a run. On a clean tree HEAD is enough;
 * with --allow-dirty we keep a `git stash create` object for tracked changes
 * plus a tree of the untracked files it cannot see, so uncommitted work
 * survives a rollback intact (SPEC §7).
 */
export async function snapshot(repo: string): Promise<GitSnapshot> {
  const head = await git(repo, ['rev-parse', 'HEAD']);
  let stash: string | null = null;
  let untracked: string | null = null;
  if (await isDirty(repo)) {
    stash = (await git(repo, ['stash', 'create'])) || null;
    untracked = await snapshotUntracked(repo);
  }
  return { head, stash, untracked };
}

/**
 * Hard-restore the working tree to a snapshot (AC-3.6). The run audit trail
 * (.copperhead/runs/) survives rollback: it is the evidence of what failed.
 */
export async function restore(repo: string, snap: GitSnapshot): Promise<void> {
  // `git clean -e` only protects untracked paths. A run directory can become
  // staged (for example while preserving failed work), and `reset --hard`
  // deletes such paths before clean runs. Copy it outside the repository so
  // the audit trail survives regardless of its index state.
  const runs = path.join(repo, '.copperhead', 'runs');
  let backupRoot: string | null = null;
  let backup: string | null = null;
  try {
    try {
      backupRoot = await mkdtemp(path.join(tmpdir(), 'copperhead-runs-'));
      backup = path.join(backupRoot, 'runs');
      if (existsSync(runs)) await cp(runs, backup, { recursive: true });
    } catch (err) {
      backup = null;
      console.warn(`warning: could not preserve failed-run audit trail before rollback: ${(err as Error).message}`);
    }

    try {
      await git(repo, ['reset', '--hard', snap.head]);
      await git(repo, ['clean', '-fd', '-e', '.copperhead/runs']);
      if (snap.stash) {
        await git(repo, ['stash', 'apply', snap.stash]);
      }
      // The clean above deleted every untracked file; put back the ones that
      // were there before the run. Never fatal: a rollback that restored the
      // tracked state is still better than one that threw halfway.
      if (snap.untracked) {
        try {
          await restoreUntracked(repo, snap.untracked);
        } catch (err) {
          console.warn(
            `warning: could not restore untracked files after rollback: ${(err as Error).message}`,
          );
        }
      }
    } finally {
      if (backup && existsSync(backup)) {
        try {
          await mkdir(path.dirname(runs), { recursive: true });
          // Restored runs are intentionally untracked; their audit contents
          // are ignored by the target-repository convention.
          await cp(backup, runs, { recursive: true, force: true });
        } catch (err) {
          console.warn(`warning: could not restore failed-run audit trail: ${(err as Error).message}`);
        }
      }
    }
  } finally {
    if (backupRoot) {
      try {
        await rm(backupRoot, { recursive: true, force: true });
      } catch (err) {
        console.warn(`warning: could not clean failed-run audit backup: ${(err as Error).message}`);
      }
    }
  }
}

/**
 * Preserve a failed run's work as a stash entry before rollback, so a failure
 * is recoverable instead of destroyed. `git stash create` alone ignores
 * untracked files (most of what a docs-stage run produces), so everything is
 * staged first; restore() resets the index anyway. Never throws: preservation
 * must not be able to block the rollback itself.
 */
export async function preserveFailedRun(repo: string, runId: string): Promise<string | null> {
  try {
    if (!(await isDirty(repo))) return null;
    await ensureIgnored(repo, GIT_ADD_EXCLUDES);
    // Never leave the audit trail staged: a staged-but-not-in-HEAD path is
    // deleted by restore()'s `reset --hard`, which silently defeats its
    // `clean -e .copperhead/runs` protection (that flag only spares untracked
    // files) — the in-flight run's transcript dir vanishes mid-run. Staging
    // then unstaging (rather than an exclude pathspec) because `git add`
    // errors outright when a pathspec touches gitignored paths, and runs/ is
    // gitignored in some target repos but tracked in others.
    await git(repo, ['add', '-A']);
    await git(repo, ['reset', '-q', '--', '.copperhead/runs']);
    const sha = await git(repo, ['stash', 'create']);
    if (!sha) return null;
    await git(repo, ['stash', 'store', '-m', `copperhead failed run ${runId}`, sha]);
    return sha;
  } catch {
    return null;
  }
}

/** Current branch name, or "HEAD" when detached. Read-only metadata probe. */
export async function branchName(repo: string): Promise<string> {
  return git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

export async function headCommit(repo: string): Promise<string> {
  return git(repo, ['rev-parse', 'HEAD']);
}

/** Count of the user's uncommitted paths, matching what the dirty gate counts. */
export async function uncommittedCount(repo: string): Promise<number> {
  return (await dirtyFiles(repo)).length;
}

export async function commitAll(repo: string, message: string): Promise<string> {
  await ensureIgnored(repo, GIT_ADD_EXCLUDES);
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

export async function changedFiles(repo: string, sinceHead: string): Promise<string[]> {
  const tracked = await git(repo, ['diff', '--name-only', sinceHead]);
  const untracked = await git(repo, ['ls-files', '--others', '--exclude-standard']);
  return [...new Set([...tracked.split('\n'), ...untracked.split('\n')])].filter(Boolean);
}
