import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import { runAgentLoop } from '../src/agent/loop.js';
import type { Msg, Provider, Turn } from '../src/agent/types.js';
import { resolveDirtyTree, describeDirtyFiles, type DirtyChoice } from '../src/util/dirty.js';
import { dirtyFiles, isDirty } from '../src/util/git.js';
import { setColorEnabled } from '../src/agent/theme.js';
import { tempFixtureRepo } from './helpers.js';

/**
 * The dirty-tree gate (AC-3.8) protects uncommitted work from a rollback's
 * hard reset. Attended runs now get offered the fixes the refusal message
 * describes instead of being sent away to run git by hand; unattended runs
 * (no chooser) keep refusing exactly as before.
 */

setColorEnabled(false);

const git = async (repo: string, args: string[]): Promise<string> =>
  (await execa('git', args, { cwd: repo })).stdout.trim();

/** A fixture repo with one uncommitted file. */
async function dirtyRepo(): Promise<{ repo: string; cleanup: () => Promise<void> }> {
  const { repo, cleanup } = await tempFixtureRepo();
  await writeFile(path.join(repo, 'wip.txt'), 'work in progress\n', 'utf8');
  return { repo, cleanup };
}

const chooser = (choice: DirtyChoice) => vi.fn(async () => choice);

describe('resolveDirtyTree', () => {
  it('commit: the work becomes a commit and the tree is clean to run on', async () => {
    const { repo, cleanup } = await dirtyRepo();
    try {
      const before = await git(repo, ['rev-parse', 'HEAD']);
      const res = await resolveDirtyTree(repo, chooser('commit'), () => {});
      expect(res.allowDirty).toBe(false);
      expect(await isDirty(repo)).toBe(false);
      expect(await git(repo, ['rev-parse', 'HEAD'])).not.toBe(before);
      expect(await git(repo, ['ls-files'])).toContain('wip.txt');
    } finally {
      await cleanup();
    }
  });

  it('stash: the tree is clean and the work is one git stash pop away', async () => {
    const { repo, cleanup } = await dirtyRepo();
    try {
      const res = await resolveDirtyTree(repo, chooser('stash'), () => {});
      expect(res.allowDirty).toBe(false);
      expect(await isDirty(repo)).toBe(false);
      expect(existsSync(path.join(repo, 'wip.txt'))).toBe(false);
      expect(await git(repo, ['stash', 'list'])).toContain('copperhead');
      await git(repo, ['stash', 'pop']);
      expect(existsSync(path.join(repo, 'wip.txt'))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('run anyway: nothing is committed or stashed; the run opts into --allow-dirty', async () => {
    const { repo, cleanup } = await dirtyRepo();
    try {
      const head = await git(repo, ['rev-parse', 'HEAD']);
      const res = await resolveDirtyTree(repo, chooser('allow-dirty'), () => {});
      expect(res.allowDirty).toBe(true);
      expect(await isDirty(repo)).toBe(true);
      expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(head);
      expect(await git(repo, ['stash', 'list'])).toBe('');
    } finally {
      await cleanup();
    }
  });

  it('cancel: the tree is left exactly as it was, for the caller to refuse over', async () => {
    const { repo, cleanup } = await dirtyRepo();
    try {
      const head = await git(repo, ['rev-parse', 'HEAD']);
      const res = await resolveDirtyTree(repo, chooser('cancel'), () => {});
      expect(res.allowDirty).toBe(false);
      expect(await isDirty(repo)).toBe(true);
      expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(head);
    } finally {
      await cleanup();
    }
  });

  it('a thrown or abandoned prompt reads as cancel, never as consent', async () => {
    const { repo, cleanup } = await dirtyRepo();
    try {
      const res = await resolveDirtyTree(
        repo,
        async () => {
          throw new Error('terminal closed');
        },
        () => {},
      );
      expect(res.allowDirty).toBe(false);
      expect(await isDirty(repo)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('a clean tree never asks', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const ask = chooser('commit');
      const res = await resolveDirtyTree(repo, ask, () => {});
      expect(ask).not.toHaveBeenCalled();
      expect(res.allowDirty).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('the earlier gates stay the preflight\'s to explain: no prompt without a repo or a commit', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ch-dirty-'));
    try {
      const ask = chooser('commit');
      expect((await resolveDirtyTree(dir, ask, () => {})).allowDirty).toBe(false);
      expect(ask).not.toHaveBeenCalled();

      await execa('git', ['init', '-q'], { cwd: dir });
      await writeFile(path.join(dir, 'a.txt'), 'x\n', 'utf8');
      expect((await resolveDirtyTree(dir, ask, () => {})).allowDirty).toBe(false);
      expect(ask).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('names paths in full, whatever their porcelain status column', async () => {
    // Regression: git() trims the whole `git status --porcelain` payload, and
    // an unstaged modification is " M path" — a leading space. Trimming ate
    // that column on the first line only, so the very first file the prompt
    // offered to commit was reported one character short ("EADME.md").
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await writeFile(path.join(repo, 'README.md'), 'seed\n', 'utf8');
      await git(repo, ['add', '-A']);
      await git(repo, ['commit', '-q', '-m', 'seed readme']);

      await writeFile(path.join(repo, 'README.md'), 'seed\nmore\n', 'utf8'); // " M" — unstaged, sorts first
      await writeFile(path.join(repo, 'wip.txt'), 'work\n', 'utf8'); // "??"
      expect(await dirtyFiles(repo)).toEqual(['README.md', 'wip.txt']);

      // A staged rename still resolves to the path that exists on disk.
      await git(repo, ['add', '-A']);
      await git(repo, ['commit', '-q', '-m', 'more']);
      await git(repo, ['mv', 'README.md', 'DOCS.md']);
      expect(await dirtyFiles(repo)).toEqual(['DOCS.md']);
    } finally {
      await cleanup();
    }
  });

  it('names the dirty files, summarizing past a cap', () => {
    const many = Array.from({ length: 14 }, (_, i) => `docs/file-${i}.md`);
    const lines = describeDirtyFiles(many);
    expect(lines).toHaveLength(11);
    expect(lines.at(-1)).toContain('4 more');
    expect(describeDirtyFiles(['a.txt'])).toEqual(['  a.txt']);
  });
});

describe('the gate inside a run', () => {
  /** Never actually reached in these tests: the run stops at the gate. */
  const idleProvider = (): Provider => ({
    name: 'scripted',
    async chat(_messages: Msg[]): Promise<Turn> {
      return { text: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    },
  });

  it('no chooser (CI, pipes): refuses with the message and its three fixes', async () => {
    const { repo, cleanup } = await dirtyRepo();
    try {
      await expect(
        runAgentLoop({ repoRoot: repo, request: 'noop', model: 'gpt-5', provider: idleProvider(), log: () => {} }),
      ).rejects.toThrow(/working tree is dirty/);
      expect(await isDirty(repo)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('cancelling the prompt lands on that same refusal', async () => {
    const { repo, cleanup } = await dirtyRepo();
    try {
      await expect(
        runAgentLoop({
          repoRoot: repo,
          request: 'noop',
          model: 'gpt-5',
          provider: idleProvider(),
          onDirtyTree: chooser('cancel'),
          log: () => {},
        }),
      ).rejects.toThrow(/working tree is dirty/);
    } finally {
      await cleanup();
    }
  });

  it('committing at the prompt lets the run start, with the work safe in history', async () => {
    const { repo, cleanup } = await dirtyRepo();
    try {
      // The run itself goes nowhere (the provider never calls a tool, so it
      // ends on the empty-completion path); what matters is that it got past
      // the gate instead of throwing, and that the rollback it then performs
      // restores to a HEAD that contains the user's work.
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'noop',
        model: 'gpt-5',
        provider: idleProvider(),
        onDirtyTree: chooser('commit'),
        log: () => {},
      });
      expect(res.transcriptDir).toBeTruthy();
      expect(await git(repo, ['ls-files'])).toContain('wip.txt');
      expect(await git(repo, ['show', '--name-only', '--format=%s', 'HEAD'])).toContain('work in progress');
    } finally {
      await cleanup();
    }
  });

  it('an explicit --allow-dirty never raises the prompt', async () => {
    const { repo, cleanup } = await dirtyRepo();
    try {
      const ask = chooser('commit');
      await runAgentLoop({
        repoRoot: repo,
        request: 'noop',
        model: 'gpt-5',
        provider: idleProvider(),
        allowDirty: true,
        onDirtyTree: ask,
        log: () => {},
      });
      expect(ask).not.toHaveBeenCalled();
      expect(await isDirty(repo)).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
