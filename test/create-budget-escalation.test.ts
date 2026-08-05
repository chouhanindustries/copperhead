import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { RunOptions, RunResult } from '../src/agent/loop.js';
import type { ExitPath } from '../src/agent/transcript.js';
import { tempFixtureRepo } from './helpers.js';

// Issue #135: a stage that dies of turn starvation used to be retried at the
// exact budget that just proved insufficient, so it could wall three times in a
// row. These drive runCreate with a scripted runAgentLoop and a scripted
// recovery diagnosis; no live provider, no network.
const mockRunAgentLoop = vi.hoisted(() => vi.fn<(opts: RunOptions) => Promise<RunResult>>());
const mockDiagnose = vi.hoisted(() => vi.fn());

vi.mock('../src/agent/loop.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runAgentLoop: mockRunAgentLoop,
}));
vi.mock('../src/agent/recovery.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  diagnoseStageFailure: mockDiagnose,
  transcriptExcerpt: async () => '',
}));
vi.mock('../src/openspec/cli.js', () => ({ openspecInit: async () => ({ ok: true, output: '' }) }));
vi.mock('../src/commands/check.js', () => ({ runCheck: async () => ({ ok: true }) }));

import { runCreate, resolveStageMaxTurns, DEFAULT_STAGE_MAX_TURNS } from '../src/commands/create.js';

/** A failed run result carrying the exit path under test. */
function failed(exitPath: ExitPath, maxTurns: number): RunResult {
  return {
    outcome: 'failure',
    exitPath,
    summary: 'mock',
    transcriptDir: '',
    filesTouched: [],
    commit: null,
    stats: {
      exitPath,
      turnsUsed: maxTurns,
      maxTurns,
      repairCyclesUsed: 0,
      maxRepairCycles: 5,
      tokensIn: 100,
      tokensOut: 50,
      perTurn: [],
      durationMs: 1000,
    },
    cacheHits: 0,
  };
}

// diagnose() constructs a provider before the mocked diagnoseStageFailure runs;
// a dummy key keeps that construction from throwing. Never actually called.
let prevKey: string | undefined;
beforeEach(() => {
  mockRunAgentLoop.mockReset();
  mockDiagnose.mockReset();
  mockDiagnose.mockResolvedValue({ verdict: 'retry', reason: 'transient', guidance: 'try again' });
  prevKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-dummy';
});
afterEach(() => {
  if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = prevKey;
});

async function seedRepo(repo: string, config?: Record<string, unknown>): Promise<string> {
  await mkdir(path.join(repo, '.copperhead'), { recursive: true });
  if (config) {
    await writeFile(path.join(repo, '.copperhead', 'config.json'), JSON.stringify(config), 'utf8');
  }
  const briefPath = path.join(repo, 'brief.md');
  await writeFile(briefPath, '# tiny\n', 'utf8');
  return briefPath;
}

/** Turn budgets, in order, that the pipeline handed the spec-seed stage. */
function specSeedBudgets(): (number | undefined)[] {
  return mockRunAgentLoop.mock.calls
    .map(([o]) => o)
    .filter((o) => o.request.includes('spec-seed'))
    .map((o) => o.maxTurns);
}

describe('turn-budget escalation across stage attempts (issue #135)', () => {
  it('raises the budget 40 → 60 → 90 over three turn-starved attempts', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo);
      mockRunAgentLoop.mockImplementation(async (opts) =>
        failed('turn-budget-exhausted', opts.maxTurns ?? 0),
      );

      const res = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: () => {} });

      expect(res.ok).toBe(false);
      // Each raise is ceil(base / 2) = 20 on top of the previous budget, so the
      // escalation is linear from the ORIGINAL budget, not compounding.
      expect(specSeedBudgets()).toEqual([40, 60, 90]);
    } finally {
      await cleanup();
    }
  });

  it('logs each raise on its own stage line', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo);
      mockRunAgentLoop.mockImplementation(async (opts) =>
        failed('turn-budget-exhausted', opts.maxTurns ?? 0),
      );

      const lines: string[] = [];
      await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: (s) => lines.push(s) });

      const raises = lines.filter((l) => l.includes("raising the next attempt's budget"));
      expect(raises).toHaveLength(2);
      expect(raises[0]).toContain('40 → 60');
      expect(raises[1]).toContain('60 → 90');
    } finally {
      await cleanup();
    }
  });

  it('does not escalate for a non-budget exit path', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo);
      mockRunAgentLoop.mockImplementation(async (opts) => failed('provider-error', opts.maxTurns ?? 0));

      const lines: string[] = [];
      const res = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: (s) => lines.push(s) });

      expect(res.ok).toBe(false);
      expect(specSeedBudgets()).toEqual([40, 40, 40]);
      expect(lines.join('\n')).not.toContain("raising the next attempt's budget");
    } finally {
      await cleanup();
    }
  });

  it('names --max-turns and stageMaxTurns when every attempt ran out of turns', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo);
      mockRunAgentLoop.mockImplementation(async (opts) =>
        failed('turn-budget-exhausted', opts.maxTurns ?? 0),
      );

      const lines: string[] = [];
      await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: (s) => lines.push(s) });

      const out = lines.join('\n');
      expect(out).toContain('this stage needs a larger budget');
      expect(out).toContain('--max-turns');
      expect(out).toContain('"stageMaxTurns": {"spec-seed": <n>}');
      expect(out).toContain('last budget 90');
    } finally {
      await cleanup();
    }
  });

  it('stays silent about the budget when the failures were not turn starvation', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo);
      mockRunAgentLoop.mockImplementation(async (opts) => failed('provider-error', opts.maxTurns ?? 0));

      const lines: string[] = [];
      await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: (s) => lines.push(s) });

      expect(lines.join('\n')).not.toContain('this stage needs a larger budget');
    } finally {
      await cleanup();
    }
  });

  it('hands the supervisor the structured exit path and the scheduled next budget', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo);
      mockRunAgentLoop.mockImplementation(async (opts) =>
        failed('turn-budget-exhausted', opts.maxTurns ?? 0),
      );

      await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: () => {} });

      const first = mockDiagnose.mock.calls[0]?.[1] as { exitPath: string; nextAttemptMaxTurns: number };
      expect(first.exitPath).toBe('turn-budget-exhausted');
      expect(first.nextAttemptMaxTurns).toBe(60);
    } finally {
      await cleanup();
    }
  });

  it('omits the scheduled-budget hint when no escalation was scheduled', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo);
      mockRunAgentLoop.mockImplementation(async (opts) => failed('provider-error', opts.maxTurns ?? 0));

      await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: () => {} });

      const first = mockDiagnose.mock.calls[0]?.[1] as { exitPath: string; nextAttemptMaxTurns?: number };
      expect(first.exitPath).toBe('provider-error');
      expect(first.nextAttemptMaxTurns).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

describe('stage turn-budget precedence (issue #135)', () => {
  const config = (over: Partial<{ maxTurns: number; stageMaxTurns: Record<string, number> }> = {}) => ({
    maxTurns: 40,
    ...over,
  });

  it('config stageMaxTurns wins over everything, including --max-turns', () => {
    expect(resolveStageMaxTurns('schematic', config({ stageMaxTurns: { schematic: 55 } }), 120)).toBe(55);
  });

  it('--max-turns wins over the built-in per-stage default', () => {
    expect(resolveStageMaxTurns('schematic', config(), 120)).toBe(120);
  });

  it('the built-in per-stage default wins over the global maxTurns', () => {
    expect(resolveStageMaxTurns('schematic', config())).toBe(100);
    expect(resolveStageMaxTurns('layout-draft', config())).toBe(80);
    expect(DEFAULT_STAGE_MAX_TURNS).toEqual({ schematic: 100, 'layout-draft': 80 });
  });

  it('a stage with no entry anywhere falls back to the global maxTurns', () => {
    expect(resolveStageMaxTurns('spec-seed', config())).toBe(40);
    expect(resolveStageMaxTurns('spec-seed', config({ maxTurns: 12 }))).toBe(12);
  });

  it('applies the whole chain through a real run', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo, { maxTurns: 40, stageMaxTurns: { 'spec-seed': 55 } });
      mockRunAgentLoop.mockImplementation(async (opts) => failed('provider-error', opts.maxTurns ?? 0));
      // Abort immediately so only the first attempt of the first stage runs.
      mockDiagnose.mockResolvedValue({ verdict: 'abort', reason: 'stop' });

      await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', maxTurns: 120, log: () => {} });

      // config's per-stage entry beats the flag for the stage it names.
      expect(specSeedBudgets()).toEqual([55]);
    } finally {
      await cleanup();
    }
  });

  it('gives the schematic stage its built-in default when nothing else is set', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo);
      // The three doc stages succeed so the run actually reaches `schematic`,
      // which then fails: enough to observe the budget it was handed.
      mockRunAgentLoop.mockImplementation(async (opts) => {
        const docs = path.join(opts.repoRoot, 'docs');
        await mkdir(docs, { recursive: true });
        if (opts.request.includes('spec-seed')) {
          await writeFile(path.join(docs, 'SPEC.md'), '# s\n\n## Budgets\n\n- sleep_current_uA: 25\n', 'utf8');
        } else if (opts.request.includes('architecture')) {
          await writeFile(path.join(docs, 'SUBSYSTEMS.md'), '# s\n\n## Power\n\nLDO regulator.\n', 'utf8');
        } else if (opts.request.includes('part-selection')) {
          await writeFile(
            path.join(docs, 'BOM.md'),
            '# b\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| R1 | 10k | R_0603 | RC0603FR-0710KL | bias |\n',
            'utf8',
          );
        } else {
          return failed('provider-error', opts.maxTurns ?? 0);
        }
        return {
          ...failed('done', opts.maxTurns ?? 0),
          outcome: 'success' as const,
          exitPath: 'done' as const,
        };
      });
      mockDiagnose.mockResolvedValue({ verdict: 'abort', reason: 'stop' });

      await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: () => {} });

      const schematic = mockRunAgentLoop.mock.calls
        .map(([o]) => o)
        .filter((o) => o.request.includes('schematic'))
        .map((o) => o.maxTurns);
      expect(schematic).toEqual([100]);
    } finally {
      await cleanup();
    }
  });
});
