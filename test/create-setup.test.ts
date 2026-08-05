import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import type { RunOptions, RunResult } from '../src/agent/loop.js';
import { tempFixtureRepo } from './helpers.js';

// Onboarding path: `copperhead create` in a directory a new user just made.
// The pipeline itself is mocked out — what these cover is everything that has
// to be true BEFORE stage 1 can run: a git repo with a commit to snapshot, and
// a brief file on disk whether the user passed text or a path.
const mockRunAgentLoop = vi.hoisted(() => vi.fn<(opts: RunOptions) => Promise<RunResult>>());

vi.mock('../src/agent/loop.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runAgentLoop: mockRunAgentLoop,
}));
vi.mock('../src/agent/recovery.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  diagnoseStageFailure: async () => ({ verdict: 'abort', reason: 'stop' }),
  transcriptExcerpt: async () => '',
}));
vi.mock('../src/openspec/cli.js', () => ({ openspecInit: async () => ({ ok: true, output: '' }) }));
vi.mock('../src/commands/check.js', () => ({ runCheck: async () => ({ ok: true }) }));

import { runCreate } from '../src/commands/create.js';
import { ensureGitReady } from '../src/util/git.js';

/** Stage 1 runs but produces nothing, so the pipeline stops after it. Setup
 *  work all happens before that, which is what these tests read. */
function emptyRun(): RunResult {
  return {
    outcome: 'success',
    exitPath: 'done',
    summary: 'mock',
    transcriptDir: '',
    filesTouched: [],
    commit: null,
    stats: {
      exitPath: 'done',
      turnsUsed: 1,
      maxTurns: 40,
      repairCyclesUsed: 0,
      maxRepairCycles: 5,
      tokensIn: 10,
      tokensOut: 5,
      perTurn: [],
      durationMs: 1,
    },
    cacheHits: 0,
  };
}

let prevKey: string | undefined;
beforeEach(() => {
  mockRunAgentLoop.mockReset();
  mockRunAgentLoop.mockImplementation(async () => emptyRun());
  // diagnose() constructs a provider before the mocked diagnosis runs.
  prevKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-dummy';
});
afterEach(() => {
  if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = prevKey;
});

async function bareDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ch-setup-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const git = async (repo: string, args: string[]): Promise<string> =>
  (await execa('git', args, { cwd: repo })).stdout.trim();

describe('create sets git up instead of refusing (onboarding)', () => {
  it('a non-git directory is initialized, ignored, and committed before stage 1', async () => {
    const { dir, cleanup } = await bareDir();
    try {
      await writeFile(path.join(dir, 'brief.md'), 'A tiny USB macro keypad\n', 'utf8');
      const lines: string[] = [];
      const res = await runCreate({
        repoRoot: dir,
        briefPath: path.join(dir, 'brief.md'),
        model: 'gpt-5',
        log: (s) => lines.push(s),
      });

      // The run stops on the unmet stage contract, not on a git preflight.
      expect(res.ok).toBe(false);
      expect(mockRunAgentLoop).toHaveBeenCalled();
      expect(existsSync(path.join(dir, '.git'))).toBe(true);
      expect(await git(dir, ['rev-parse', '--verify', 'HEAD'])).toMatch(/^[0-9a-f]{40}$/);
      // The brief is committed, so a stage rollback (reset --hard + clean -fd)
      // cannot delete the file the resume command points at.
      expect(await git(dir, ['ls-files'])).toContain('brief.md');
      const ignored = await readFile(path.join(dir, '.gitignore'), 'utf8');
      expect(ignored).toContain('.env');
      expect(ignored).toContain('.copperhead/runs/');
      expect(lines.join('\n')).toMatch(/initialized a git repository/);
    } finally {
      await cleanup();
    }
  });

  it('an existing repo with an unborn HEAD gets the initial commit, not a refusal', async () => {
    const { dir, cleanup } = await bareDir();
    try {
      await execa('git', ['init', '-q'], { cwd: dir });
      await writeFile(path.join(dir, 'brief.md'), 'A tiny USB macro keypad\n', 'utf8');
      const res = await runCreate({ repoRoot: dir, briefPath: path.join(dir, 'brief.md'), model: 'gpt-5', log: () => {} });
      expect(res.ok).toBe(false);
      expect(await git(dir, ['ls-files'])).toContain('brief.md');
    } finally {
      await cleanup();
    }
  });

  it('a repo that already has commits keeps its history: only the brief is committed', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const before = await git(repo, ['rev-parse', 'HEAD']);
      await writeFile(path.join(repo, 'untouched.txt'), 'user WIP\n', 'utf8');
      await runCreate({ repoRoot: repo, briefText: 'A tiny USB macro keypad', model: 'gpt-5', log: () => {} });
      const after = await git(repo, ['rev-parse', 'HEAD']);
      expect(after).not.toBe(before);
      expect(await git(repo, ['ls-files'])).toContain('brief.md');
      // The user's unrelated working file was not swept into the brief commit.
      expect(await git(repo, ['ls-files'])).not.toContain('untouched.txt');
      expect(existsSync(path.join(repo, 'untouched.txt'))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('ensureGitReady is idempotent and never rewrites history on a healthy repo', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const head = await git(repo, ['rev-parse', 'HEAD']);
      const first = await ensureGitReady(repo);
      const second = await ensureGitReady(repo);
      expect(first).toEqual({ initialized: false, identityConfigured: false, committed: false });
      expect(second).toEqual(first);
      expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(head);
    } finally {
      await cleanup();
    }
  });

  it('an empty directory still gets a commit to snapshot against', async () => {
    const { dir, cleanup } = await bareDir();
    try {
      const setup = await ensureGitReady(dir);
      expect(setup.initialized).toBe(true);
      expect(setup.committed).toBe(true);
      expect(await git(dir, ['rev-parse', '--verify', 'HEAD'])).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await cleanup();
    }
  });
});

describe('create accepts the brief as text', () => {
  it('writes the text to brief.md and runs the pipeline against it', async () => {
    const { dir, cleanup } = await bareDir();
    try {
      await runCreate({ repoRoot: dir, briefText: 'A tiny USB macro keypad, 4 keys, USB-C', model: 'gpt-5', log: () => {} });
      const written = await readFile(path.join(dir, 'brief.md'), 'utf8');
      expect(written).toBe('A tiny USB macro keypad, 4 keys, USB-C\n');
      // The stage prompt carries the brief the user typed.
      expect(mockRunAgentLoop.mock.calls[0]![0].stagePrompt).toContain('A tiny USB macro keypad, 4 keys, USB-C');
    } finally {
      await cleanup();
    }
  });

  it('re-running the same text reuses the brief instead of littering numbered copies', async () => {
    const { dir, cleanup } = await bareDir();
    try {
      const opts = { repoRoot: dir, briefText: 'A tiny USB macro keypad', model: 'gpt-5', log: () => {} };
      await runCreate(opts);
      await runCreate(opts);
      expect(existsSync(path.join(dir, 'brief.md'))).toBe(true);
      expect(existsSync(path.join(dir, 'brief-2.md'))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('never overwrites a different existing brief', async () => {
    const { dir, cleanup } = await bareDir();
    try {
      await writeFile(path.join(dir, 'brief.md'), 'an older brief\n', 'utf8');
      await runCreate({ repoRoot: dir, briefText: 'a different device', model: 'gpt-5', log: () => {} });
      expect(await readFile(path.join(dir, 'brief.md'), 'utf8')).toBe('an older brief\n');
      expect(await readFile(path.join(dir, 'brief-2.md'), 'utf8')).toBe('a different device\n');
    } finally {
      await cleanup();
    }
  });

  it('a positional argument naming an existing file is used as that file', async () => {
    const { dir, cleanup } = await bareDir();
    try {
      await writeFile(path.join(dir, 'keypad.md'), 'brief from a file\n', 'utf8');
      await runCreate({ repoRoot: dir, briefText: 'keypad.md', model: 'gpt-5', log: () => {} });
      expect(existsSync(path.join(dir, 'brief.md'))).toBe(false);
      expect(mockRunAgentLoop.mock.calls[0]![0].stagePrompt).toContain('brief from a file');
    } finally {
      await cleanup();
    }
  });

  it('empty text is refused with a usage hint, not an empty brief file', async () => {
    const { dir, cleanup } = await bareDir();
    try {
      await expect(runCreate({ repoRoot: dir, briefText: '   ', model: 'gpt-5', log: () => {} })).rejects.toThrow(
        /brief is empty/,
      );
      expect(existsSync(path.join(dir, 'brief.md'))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('a missing --brief file is named in the error', async () => {
    const { dir, cleanup } = await bareDir();
    try {
      await expect(
        runCreate({ repoRoot: dir, briefPath: 'nope.md', model: 'gpt-5', log: () => {} }),
      ).rejects.toThrow(/brief not found: nope\.md/);
    } finally {
      await cleanup();
    }
  });
});
