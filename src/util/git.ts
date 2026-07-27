import { execa } from 'execa';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PreflightError } from './preflight.js';

/**
 * Paths copperhead must keep out of `git add -A`. KiCad ≥9 writes a
 * git-backed local-history directory (`.history/`, complete with its own nested
 * `.git`) into the project the first time kicad-cli touches it. Left untracked,
 * that nested repo has an unborn HEAD, so a plain `git add -A` in the parent
 * aborts with `error: '.history/' does not have a commit checked out` (exit
 * 128) — which fails the commit at the end of every KiCad-touching stage
 * (schematic, layout, outputs). Ignoring it is both correct (local history is
 * never a project artifact) and the fix for that abort. Kept as a list so other
 * KiCad transients can join it if they surface.
 */
const GIT_ADD_EXCLUDES = ['.history/'];

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
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', args, { cwd: repo });
  return stdout.trim();
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
  const status = await git(repo, ['status', '--porcelain']);
  return status.length > 0;
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
 * Snapshot the working tree before a run. On a clean tree HEAD is enough;
 * with --allow-dirty we keep a `git stash create` object so uncommitted work
 * survives a rollback (SPEC §7).
 */
export async function snapshot(repo: string): Promise<GitSnapshot> {
  const head = await git(repo, ['rev-parse', 'HEAD']);
  let stash: string | null = null;
  if (await isDirty(repo)) {
    stash = (await git(repo, ['stash', 'create'])) || null;
  }
  return { head, stash };
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

/** Count of uncommitted paths (staged, unstaged, and untracked). */
export async function uncommittedCount(repo: string): Promise<number> {
  const status = await git(repo, ['status', '--porcelain']);
  return status ? status.split('\n').length : 0;
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
