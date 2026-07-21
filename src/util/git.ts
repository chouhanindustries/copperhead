import { execa } from 'execa';
import { PreflightError } from './preflight.js';

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
  await git(repo, ['reset', '--hard', snap.head]);
  await git(repo, ['clean', '-fd', '-e', '.copperhead/runs']);
  if (snap.stash) {
    await git(repo, ['stash', 'apply', snap.stash]);
  }
}

export async function commitAll(repo: string, message: string): Promise<string> {
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

export async function changedFiles(repo: string, sinceHead: string): Promise<string[]> {
  const tracked = await git(repo, ['diff', '--name-only', sinceHead]);
  const untracked = await git(repo, ['ls-files', '--others', '--exclude-standard']);
  return [...new Set([...tracked.split('\n'), ...untracked.split('\n')])].filter(Boolean);
}
