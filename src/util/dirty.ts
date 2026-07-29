import { commitAll, dirtyFiles, hasCommits, isDirty, isGitRepo, stashDirty } from './git.js';
import { dim, ok } from '../agent/theme.js';
import type { SelectItem } from './select.js';

/**
 * The dirty-tree gate (AC-3.8) exists because a rollback hard-resets to the
 * pre-run snapshot, which would destroy uncommitted work. That reasoning is
 * sound; refusing outright is not the only way to honor it. Attended runs get
 * offered the three fixes the refusal message already spells out, and the run
 * continues with whichever one the user picks. Unattended runs (CI, pipes)
 * have nobody to ask, so they keep refusing exactly as before.
 */
export type DirtyChoice = 'commit' | 'stash' | 'allow-dirty' | 'cancel';

export interface DirtyTreeState {
  /** Uncommitted paths: staged, unstaged, and untracked. */
  files: string[];
}

/** Asked when the tree is dirty and the run has not opted into --allow-dirty. */
export type DirtyChooser = (state: DirtyTreeState) => Promise<DirtyChoice>;

/** The menu offered to an attended run, in recommended order. */
export const DIRTY_CHOICES: SelectItem[] = [
  { value: 'commit', label: 'commit', description: 'keep your changes as a commit (recommended)' },
  { value: 'stash', label: 'stash', description: 'set them aside; git stash pop restores them' },
  { value: 'allow-dirty', label: 'run anyway', description: 'kept through a rollback via git stash create' },
  { value: 'cancel', label: 'cancel', description: 'change nothing and stop' },
];

/** How many dirty paths to name before summarizing the rest. */
const LIST_CAP = 10;

/** The uncommitted paths, for a prompt that tells the user what is at stake. */
export function describeDirtyFiles(files: string[]): string[] {
  const shown = files.slice(0, LIST_CAP).map((f) => dim(`  ${f}`));
  if (files.length > LIST_CAP) shown.push(dim(`  …and ${files.length - LIST_CAP} more`));
  return shown;
}

/**
 * Offer the user a way through the dirty-tree gate and apply their choice.
 * Returns whether the run should proceed with `allowDirty` set; a clean tree,
 * a repo that fails an earlier gate, or a cancelled prompt all return false and
 * leave the caller's normal preflight to do its usual job (which, for cancel,
 * means the familiar refusal with its three fixes).
 */
export async function resolveDirtyTree(
  repo: string,
  choose: DirtyChooser,
  log: (line: string) => void,
): Promise<{ allowDirty: boolean }> {
  // Earlier gates (not a repo, unborn HEAD) are not ours to answer here: let
  // the preflight report those, so each failure keeps exactly one explanation.
  if (!(await isGitRepo(repo)) || !(await hasCommits(repo))) return { allowDirty: false };
  if (!(await isDirty(repo))) return { allowDirty: false };

  const files = await dirtyFiles(repo);
  const choice = await choose({ files }).catch(() => 'cancel' as DirtyChoice);
  switch (choice) {
    case 'commit': {
      const sha = await commitAll(repo, 'chore: save work in progress before a copperhead run');
      log(ok(`  committed ${files.length} file(s) as ${sha.slice(0, 7)}; a rollback now returns here`));
      return { allowDirty: false };
    }
    case 'stash': {
      const clean = await stashDirty(repo, 'copperhead: set aside before a run');
      log(ok(`  stashed ${files.length} file(s); restore them with git stash pop`));
      // A stash that left something behind (an ignored-but-tracked oddity, an
      // unreadable path) falls through to the normal refusal rather than
      // becoming a run that could roll over the leftovers.
      if (!clean) log(dim('  some paths could not be stashed; the tree is still dirty'));
      return { allowDirty: false };
    }
    case 'allow-dirty':
      log(dim('  running on the dirty tree; the snapshot keeps your changes and a rollback restores them'));
      return { allowDirty: true };
    default:
      return { allowDirty: false };
  }
}
