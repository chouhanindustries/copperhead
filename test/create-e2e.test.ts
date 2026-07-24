import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunOptions, RunResult } from '../src/agent/loop.js';
import { tempFixtureRepo } from './helpers.js';

const mockRunAgentLoop = vi.hoisted(() => vi.fn<(opts: RunOptions) => Promise<RunResult>>());
const mockRunCheck = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock('../src/agent/loop.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runAgentLoop: mockRunAgentLoop,
}));
vi.mock('../src/openspec/cli.js', () => ({
  openspecInit: async () => ({ ok: true, output: 'mocked' }),
}));
vi.mock('../src/commands/check.js', () => ({
  runCheck: mockRunCheck,
}));

import { runCreate, STAGES } from '../src/commands/create.js';

function ok(): RunResult {
  return {
    outcome: 'success',
    exitPath: 'done',
    summary: 'scripted e2e stage',
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
    cacheHits: 1,
  };
}

const stageName = (opts: RunOptions): string =>
  opts.request.replace('create pipeline stage: ', '');

async function seed(repo: string): Promise<string> {
  await mkdir(path.join(repo, '.copperhead'), { recursive: true });
  await writeFile(
    path.join(repo, '.copperhead', 'config.json'),
    JSON.stringify({ maxStageRetries: 0 }),
    'utf8',
  );
  const brief = path.join(repo, 'brief.md');
  await writeFile(brief, '# Scripted medium-complexity board\n', 'utf8');
  return brief;
}

afterEach(() => {
  vi.restoreAllMocks();
  mockRunAgentLoop.mockReset();
  mockRunCheck.mockClear();
});

describe('create pipeline deterministic end-to-end coverage', () => {
  it('reaches all eight stages and the final check', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seed(repo);
      for (const stage of STAGES) {
        vi.spyOn(stage, 'isComplete').mockImplementation((root) =>
          existsSync(path.join(root, `.e2e-${stage.name}`)),
        );
      }
      mockRunAgentLoop.mockImplementation(async (opts) => {
        await writeFile(path.join(opts.repoRoot, `.e2e-${stageName(opts)}`), 'complete\n', 'utf8');
        return ok();
      });

      const result = await runCreate({
        repoRoot: repo,
        briefPath,
        model: 'gpt-5',
        log: () => {},
      });

      expect(result).toEqual({ ok: true, completed: STAGES.map((stage) => stage.name) });
      expect(mockRunAgentLoop.mock.calls.map(([opts]) => stageName(opts))).toEqual(
        STAGES.map((stage) => stage.name),
      );
      expect(mockRunCheck).toHaveBeenCalledOnce();
    } finally {
      await cleanup();
    }
  });

  it('fails loudly when the final stage is not reached', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seed(repo);
      for (const stage of STAGES) {
        vi.spyOn(stage, 'isComplete').mockImplementation((root) =>
          existsSync(path.join(root, `.e2e-${stage.name}`)),
        );
      }
      mockRunAgentLoop.mockImplementation(async (opts) => {
        if (stageName(opts) !== 'devplan') {
          await writeFile(path.join(opts.repoRoot, `.e2e-${stageName(opts)}`), 'complete\n', 'utf8');
        }
        return ok();
      });

      const result = await runCreate({
        repoRoot: repo,
        briefPath,
        model: 'gpt-5',
        log: () => {},
      });

      expect(result.ok).toBe(false);
      expect(result.completed).toEqual(STAGES.slice(0, -1).map((stage) => stage.name));
      expect(mockRunCheck).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it('does not false-green an empty ERC-clean schematic or run later stages', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seed(repo);
      mockRunAgentLoop.mockImplementation(async (opts) => {
        const docs = path.join(opts.repoRoot, 'docs');
        await mkdir(docs, { recursive: true });
        if (stageName(opts) === 'spec-seed') {
          await writeFile(path.join(docs, 'SPEC.md'), '# Spec\n\n## Budgets\n', 'utf8');
        } else if (stageName(opts) === 'architecture') {
          await writeFile(path.join(docs, 'SUBSYSTEMS.md'), '# Subsystems\n', 'utf8');
        } else if (stageName(opts) === 'part-selection') {
          await writeFile(path.join(docs, 'BOM.md'), '# BOM\n', 'utf8');
        }
        // Deliberately leave the scaffolded schematic empty. Its ERC result is
        // clean, but the real stage contract must reject its zero symbols.
        return ok();
      });

      const result = await runCreate({
        repoRoot: repo,
        briefPath,
        model: 'gpt-5',
        log: () => {},
      });

      expect(result).toEqual({
        ok: false,
        completed: ['spec-seed', 'architecture', 'part-selection'],
      });
      expect(mockRunAgentLoop.mock.calls.map(([opts]) => stageName(opts))).toEqual([
        'spec-seed',
        'architecture',
        'part-selection',
        'schematic',
      ]);
      expect(mockRunCheck).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });
});
