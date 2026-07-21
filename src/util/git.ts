import { execa } from 'execa';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

export async function isDirty(repo: string): Promise<boolean> {
  const status = await git(repo, ['status', '--porcelain']);
  return status.length > 0;
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
