import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const runAgentLoop = vi.fn(async () => ({
  outcome: 'failure' as const,
  exitPath: 'provider-error' as const,
  summary: 'failed',
  transcriptDir: '/tmp/run',
  filesTouched: [],
  commit: null,
}));

vi.mock('../src/agent/loop.js', () => ({ runAgentLoop }));
vi.mock('../src/openspec/cli.js', () => ({ openspecInit: vi.fn(async () => undefined) }));

const { runCreate } = await import('../src/commands/create.js');

afterEach(() => runAgentLoop.mockClear());

describe('--keep-on-fail CLI wiring', () => {
  it('forwards create keepOnFail to every stage loop', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'ch-create-keep-'));
    try {
      const brief = path.join(repo, 'brief.md');
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
      await rm(repo, { recursive: true, force: true });
    }
  });
});
