import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import { runAgentLoop } from '../src/agent/loop.js';
import type { Msg, Provider, Turn } from '../src/agent/types.js';
import { runInit } from '../src/memory/scaffold.js';
import { tempFixtureRepo } from './helpers.js';

/**
 * A failed rollback must not take the run's own report down with it.
 *
 * `restore` shells out to git and throws on anything git refuses. The
 * reachable case is `git stash apply`: `snapshot` records a `git stash create`
 * object, which git leaves unreferenced by design, so a `git gc` during a long
 * run collects it and the rollback throws afterwards. These tests reproduce
 * that by running the gc themselves rather than by stubbing git.
 *
 * `fail()` already handled this. The refuse and dry-run paths did not, and an
 * unhandled throw there skips `run-end` and `summary.md` entirely.
 */
function scriptedProvider(turns: Partial<Turn>[], beforeTurn?: () => Promise<void>): Provider {
  let i = 0;
  return {
    name: 'scripted',
    async chat(_messages: Msg[]): Promise<Turn> {
      if (beforeTurn) await beforeTurn();
      const t = turns[Math.min(i, turns.length - 1)]!;
      i++;
      return {
        text: t.text ?? null,
        toolCalls: (t.toolCalls ?? []).map((c, j) => ({ ...c, id: `call-${i}-${j}` })),
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
}

/**
 * A repo where the run starts `--allow-dirty` over uncommitted work, so the
 * snapshot carries a stash object, and that object is then collected.
 */
async function repoWithCollectedStash(): Promise<{ repo: string; cleanup: () => Promise<void> }> {
  const t = await tempFixtureRepo();
  await runInit({ repoRoot: t.repo, installHooks: false });
  await execa('git', ['add', '-A'], { cwd: t.repo });
  await execa('git', ['commit', '-q', '-m', 'docs'], { cwd: t.repo });
  // Uncommitted user work: this is what makes `snapshot` create a stash object.
  await writeFile(path.join(t.repo, 'docs', 'BOM.md'), '# hand edit in progress\n', 'utf8');
  return t;
}

/** Collect the unreferenced stash object the in-flight snapshot is holding. */
const collectStash = (repo: string): Promise<unknown> =>
  execa('git', ['gc', '--prune=now', '--quiet'], { cwd: repo, reject: false });

const summaryOf = async (dir: string): Promise<string> => readFile(path.join(dir, 'summary.md'), 'utf8');

describe('a failed rollback does not swallow the run report', () => {
  it('refuse path: still writes summary.md and names the rollback failure', async () => {
    const { repo, cleanup } = await repoWithCollectedStash();
    try {
      // The gc runs between turns, i.e. after `snapshot` and before the
      // rollback, which is exactly where a long run's gc would land.
      const provider = scriptedProvider(
        [{ toolCalls: [{ name: 'finish', args: { outcome: 'refuse', summary: 'budget says no' } }] }],
        () => collectStash(repo).then(() => undefined),
      );
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'refuse me',
        model: 'gpt-5',
        provider,
        allowDirty: true,
        log: () => {},
      });

      // The run reported itself rather than dying inside the rollback.
      expect(res.outcome).toBe('refused');
      expect(res.exitPath).toBe('refused');
      const summary = await summaryOf(res.transcriptDir);
      expect(summary).toContain('REFUSED: budget says no');
      expect(summary).toContain('ROLLBACK FAILED');
      expect(summary).toContain('git status');
    } finally {
      await cleanup();
    }
  }, 30_000);

  it('dry-run path: does not claim "changes reverted" when the revert failed', async () => {
    const { repo, cleanup } = await repoWithCollectedStash();
    try {
      const provider = scriptedProvider(
        [{ toolCalls: [{ name: 'finish', args: { outcome: 'done', summary: 'proposed' } }] }],
        () => collectStash(repo).then(() => undefined),
      );
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'propose only',
        model: 'gpt-5',
        provider,
        allowDirty: true,
        dryRun: true,
        log: () => {},
      });

      const summary = await summaryOf(res.transcriptDir);
      expect(summary).toContain('REVERT FAILED');
      expect(summary).not.toContain('dry run: changes reverted');
    } finally {
      await cleanup();
    }
  }, 30_000);

  it('a rollback that succeeds still reports the plain outcome', async () => {
    const { repo, cleanup } = await repoWithCollectedStash();
    try {
      const provider = scriptedProvider([
        { toolCalls: [{ name: 'finish', args: { outcome: 'refuse', summary: 'budget says no' } }] },
      ]);
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'refuse me',
        model: 'gpt-5',
        provider,
        allowDirty: true,
        log: () => {},
      });
      const summary = await summaryOf(res.transcriptDir);
      expect(summary).toContain('REFUSED: budget says no');
      expect(summary).not.toContain('ROLLBACK FAILED');
    } finally {
      await cleanup();
    }
  }, 30_000);
});
