import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { tempFixtureRepo } from './helpers.js';

const runAgentLoop = vi.fn(async () => ({
  outcome: 'failure' as const,
  exitPath: 'provider-error' as const,
  summary: 'failed',
  transcriptDir: '/tmp/run',
  filesTouched: [],
  commit: null,
}));
const openspecInit = vi.fn(async () => undefined);

vi.mock('../src/agent/loop.js', () => ({ runAgentLoop }));
vi.mock('../src/openspec/cli.js', () => ({ openspecInit }));

const { runCreate } = await import('../src/commands/create.js');

afterEach(() => {
  runAgentLoop.mockClear();
  openspecInit.mockClear();
});

describe('--keep-on-fail CLI wiring', () => {
  it('forwards create keepOnFail to every stage loop', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    const briefDir = await mkdtemp(path.join(tmpdir(), 'ch-create-brief-'));
    try {
      const brief = path.join(briefDir, 'brief.md');
      await writeFile(brief, 'A tiny board', 'utf8');
      const result = await runCreate({
        repoRoot: repo,
        briefPath: brief,
        model: 'gpt-5',
        keepOnFail: true,
        log: () => {},
      });
      expect(result.ok).toBe(false);
      expect(runAgentLoop).toHaveBeenCalledWith(expect.objectContaining({ keepOnFail: true }));
    } finally {
      await cleanup();
      await rm(briefDir, { recursive: true, force: true });
    }
  });

  it('refuses a rerun before partial kept output can satisfy a stage completion marker', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    const briefDir = await mkdtemp(path.join(tmpdir(), 'ch-create-rerun-'));
    try {
      const brief = path.join(briefDir, 'brief.md');
      await writeFile(brief, 'A tiny board', 'utf8');
      const lines: string[] = [];
      runAgentLoop.mockImplementationOnce(async () => {
        await mkdir(path.join(repo, 'firmware'), { recursive: true });
        await writeFile(path.join(repo, 'firmware', 'partial.c'), '/* unverified */\n', 'utf8');
        return {
          outcome: 'failure' as const,
          exitPath: 'provider-error' as const,
          summary: 'failed',
          transcriptDir: '/tmp/run',
          filesTouched: ['firmware/partial.c'],
          commit: null,
        };
      });

      const first = await runCreate({
        repoRoot: repo,
        briefPath: brief,
        model: 'gpt-5',
        keepOnFail: true,
        log: (line) => lines.push(line),
      });
      expect(first.ok).toBe(false);
      expect(lines.join('\n')).toContain('recover the tree before rerunning create');
      const callsAfterFailure = runAgentLoop.mock.calls.length;
      const { stdout: dirty } = await execa('git', ['status', '--porcelain'], { cwd: repo });
      expect(dirty).toContain('firmware/');

      await expect(
        runCreate({ repoRoot: repo, briefPath: brief, model: 'gpt-5', log: () => {} }),
      ).rejects.toThrow(/create refuses to infer completed stages/);
      expect(runAgentLoop).toHaveBeenCalledTimes(callsAfterFailure);
    } finally {
      await cleanup();
      await rm(briefDir, { recursive: true, force: true });
    }
  });

  it('restores command-entry state when the first ordinary failure leaves OpenSpec bootstrap dirt', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    const briefDir = await mkdtemp(path.join(tmpdir(), 'ch-create-bootstrap-'));
    try {
      const brief = path.join(briefDir, 'brief.md');
      await writeFile(brief, 'A tiny board', 'utf8');
      openspecInit.mockImplementationOnce(async () => {
        await mkdir(path.join(repo, 'openspec'), { recursive: true });
        await writeFile(path.join(repo, 'openspec', 'config.yaml'), 'schema: spec-driven\n', 'utf8');
        return undefined;
      });

      const result = await runCreate({
        repoRoot: repo,
        briefPath: brief,
        model: 'gpt-5',
        log: () => {},
      });
      expect(result.ok).toBe(false);
      const { stdout: status } = await execa('git', ['status', '--porcelain'], { cwd: repo });
      expect(status).toBe('');
    } finally {
      await cleanup();
      await rm(briefDir, { recursive: true, force: true });
    }
  });
});
