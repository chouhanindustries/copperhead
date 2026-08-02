import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { RunOptions } from '../src/agent/loop.js';
import { tempFixtureRepo } from './helpers.js';

/**
 * Issue #145 §A: `REPORT.md` reports one wall/turn/token figure per stage, so a
 * stage with one 43k-token turn and a stage with forty even ones look
 * identical. These tests pin the concentration columns onto both report
 * surfaces, and check that a configured `stageBudgets` entry actually reaches
 * the stage's run.
 */

/** A deliberately bimodal stage: one giant turn among four small ones. */
const PER_TURN = [
  { turn: 1, in: 100, out: 60, ms: 900 },
  { turn: 2, in: 100, out: 20_000, ms: 240_000 },
  { turn: 3, in: 100, out: 80, ms: 700 },
  { turn: 4, in: 100, out: 90, ms: 800 },
];

const mockRunAgentLoop = vi.hoisted(() =>
  vi.fn(async (opts: RunOptions) => {
    const { writeFile: writeFileFs, mkdir: mkdirFs } = await import('node:fs/promises');
    const { default: pathMod } = await import('node:path');
    const docs = pathMod.join(opts.repoRoot, 'docs');
    await mkdirFs(docs, { recursive: true });
    if (opts.request.includes('spec-seed'))
      await writeFileFs(pathMod.join(docs, 'SPEC.md'), '# spec\n\n## Budgets\n\n- sleep_current_uA: 25\n', 'utf8');
    if (opts.request.includes('architecture'))
      await writeFileFs(pathMod.join(docs, 'SUBSYSTEMS.md'), '# subsystems\n\n## Power\n\nLDO 3.3 V.\n', 'utf8');
    if (opts.request.includes('part-selection'))
      await writeFileFs(
        pathMod.join(docs, 'BOM.md'),
        '# bom\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| R1 | 10k | R_0603 | RC0603 | bias |\n',
        'utf8',
      );
    return {
      outcome: 'success' as const,
      exitPath: 'done' as const,
      summary: 'mocked',
      transcriptDir: '',
      filesTouched: [],
      commit: null,
      stats: {
        exitPath: 'done' as const,
        turnsUsed: 4,
        maxTurns: 40,
        repairCyclesUsed: 0,
        maxRepairCycles: 5,
        tokensIn: 400,
        tokensOut: 20_230,
        perTurn: PER_TURN,
        durationMs: 242_400,
        editPressure: {
          edits: 8,
          editBytes: 24_000,
          largestEditBytes: 17_884,
          verifications: 2,
          editBytesPerVerify: 12_000,
        },
      },
      cacheHits: 1,
    };
  }),
);

vi.mock('../src/agent/loop.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runAgentLoop: mockRunAgentLoop,
}));
vi.mock('../src/openspec/cli.js', () => ({
  openspecInit: async () => ({ ok: true, output: 'mocked' }),
}));
vi.mock('../src/commands/check.js', () => ({
  runCheck: async () => ({ ok: true }),
}));

import { runCreate } from '../src/commands/create.js';

async function seedRepo(config: Record<string, unknown>): Promise<{
  repo: string;
  briefPath: string;
  cleanup: () => Promise<void>;
}> {
  const { repo, cleanup } = await tempFixtureRepo();
  await mkdir(path.join(repo, '.copperhead'), { recursive: true });
  await writeFile(path.join(repo, '.copperhead', 'config.json'), JSON.stringify(config), 'utf8');
  const briefPath = path.join(repo, 'brief.md');
  await writeFile(briefPath, '# A tiny device\n', 'utf8');
  return { repo, briefPath, cleanup };
}

describe('per-stage cost report carries turn-cost concentration (issue #145 §A)', () => {
  it('report.json gains the concentration and edit-pressure columns', async () => {
    const { repo, briefPath, cleanup } = await seedRepo({});
    try {
      await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: () => {} });
      const report = JSON.parse(
        await readFile(path.join(repo, '.copperhead', 'runs', 'report.json'), 'utf8'),
      ) as { stages: Record<string, unknown>[] };
      const specSeed = report.stages.find((s) => s.name === 'spec-seed')!;
      expect(specSeed.p50TurnOut).toBe(80);
      expect(specSeed.p95TurnOut).toBe(20_000);
      expect(specSeed.maxTurnOut).toBe(20_000);
      // One turn of four carrying 98% of the output is the shape that dies.
      expect(specSeed.top5TurnShare).toBe(1);
      expect(specSeed.slowestTurnMs).toBe(240_000);
      expect(specSeed.editBytesPerVerify).toBe(12_000);
      expect(specSeed.largestEditBytes).toBe(17_884);
    } finally {
      await cleanup();
    }
  });

  it('a resumed stage reports null rather than a zeroed concentration', async () => {
    const { repo, briefPath, cleanup } = await seedRepo({});
    try {
      // SPEC.md already satisfies the spec-seed contract, so that stage resumes.
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(path.join(repo, 'docs', 'SPEC.md'), '# spec\n\n## Budgets\n\n- sleep_current_uA: 25\n', 'utf8');
      await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: () => {} });
      const report = JSON.parse(
        await readFile(path.join(repo, '.copperhead', 'runs', 'report.json'), 'utf8'),
      ) as { stages: Record<string, unknown>[] };
      const specSeed = report.stages.find((s) => s.name === 'spec-seed')!;
      expect(specSeed.resumed).toBe(true);
      expect(specSeed.p50TurnOut).toBeNull();
      expect(specSeed.top5TurnShare).toBeNull();
      expect(specSeed.editBytesPerVerify).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('REPORT.md renders a concentration table beside the cost table', async () => {
    const { repo, briefPath, cleanup } = await seedRepo({});
    try {
      await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: () => {} });
      const md = await readFile(path.join(repo, '.copperhead', 'runs', 'REPORT.md'), 'utf8');
      expect(md).toContain('## Turn-cost concentration');
      expect(md).toContain('| Stage | p50 out | p95 out | Max out | Top-5 share | Slowest turn | B/verify | Largest edit |');
      expect(md).toMatch(/\| spec-seed \| 80 \| 20000 \| 20000 \| 1\.00 \|/);
      expect(md).toContain('| 12000 | 17884 |');
    } finally {
      await cleanup();
    }
  });
});

describe('per-stage spend budgets reach the stage run (issue #145 §C)', () => {
  it('a stageBudgets entry is forwarded; stages without one get no budget', async () => {
    const { repo, briefPath, cleanup } = await seedRepo({
      stageBudgets: {
        'spec-seed': { maxTokensOut: 120_000, maxWallMs: 2_400_000, maxTurnOut: 8000 },
        architecture: { maxTokensOut: 0 }, // dropped as meaningless
      },
    });
    try {
      mockRunAgentLoop.mockClear();
      await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: () => {} });
      const calls = mockRunAgentLoop.mock.calls.map(([o]) => o);
      const specSeed = calls.find((o) => o.request.includes('spec-seed'));
      const architecture = calls.find((o) => o.request.includes('architecture'));
      expect(specSeed?.budget).toEqual({ maxTokensOut: 120_000, maxWallMs: 2_400_000, maxTurnOut: 8000 });
      expect(architecture?.budget).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('the schematic stage prompt carries the computed progress line', async () => {
    const { repo, briefPath, cleanup } = await seedRepo({});
    try {
      mockRunAgentLoop.mockClear();
      await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: () => {} });
      const schematic = mockRunAgentLoop.mock.calls.map(([o]) => o).find((o) => o.request.includes('schematic'));
      expect(schematic).toBeDefined();
      // BOM.md holds R1 only, and the stage runs against the freshly
      // scaffolded (empty) schematic, so the line names R1 as the first unit.
      expect(schematic!.stagePrompt).toContain('Progress: 0 of 1 BOM parts present in the schematic');
      expect(schematic!.stagePrompt).toContain('missing: R1');
      expect(schematic!.stagePrompt).toContain('Continue at the first missing unit');
    } finally {
      await cleanup();
    }
  });
});
