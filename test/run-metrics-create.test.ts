import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import type { RunOptions } from '../src/agent/loop.js';
import { tempFixtureRepo } from './helpers.js';

// Isolated from run-metrics.test.ts: this file mocks runAgentLoop entirely
// (following the pattern in create-stage-turns.test.ts) so it can exercise
// create.ts's own stage-boundary report/commit logic without the cost of a
// real multi-stage agent loop. run-metrics.test.ts covers the real loop.ts
// behavior with the genuine runAgentLoop.
/** For each call, whether report.json already carried a `running: true` row
 *  for the stage about to run — proof the stage-start write (AC-16.4) landed
 *  on disk before this stage's own runAgentLoop call, not after. */
const sawRunningAtCallTime: boolean[] = [];

const mockRunAgentLoop = vi.hoisted(() =>
  vi.fn(async (opts: RunOptions) => {
    const { mkdir: mkdirFs, writeFile: writeFileFs, readFile: readFileFs } = await import('node:fs/promises');
    const { existsSync: existsSyncFs } = await import('node:fs');
    const { default: pathMod } = await import('node:path');
    const stageName = opts.request.replace('create pipeline stage: ', '');
    const reportPath = pathMod.join(opts.repoRoot, '.copperhead', 'runs', 'report.json');
    if (existsSyncFs(reportPath)) {
      const report = JSON.parse(await readFileFs(reportPath, 'utf8')) as {
        stages: { name: string; status: string }[];
      };
      sawRunningAtCallTime.push(report.stages.some((s) => s.name === stageName && s.status === 'running'));
    } else {
      sawRunningAtCallTime.push(false);
    }
    const docs = pathMod.join(opts.repoRoot, 'docs');
    await mkdirFs(docs, { recursive: true });
    if (opts.request.includes('spec-seed')) {
      await writeFileFs(pathMod.join(docs, 'SPEC.md'), '# spec\n\n## Budgets\n\n- sleep_current_uA: 25\n', 'utf8');
    }
    if (opts.request.includes('architecture')) {
      await writeFileFs(
        pathMod.join(docs, 'SUBSYSTEMS.md'),
        '# subsystems\n\n## Power\n\nLDO regulator 3.3 V, 300 mA.\n',
        'utf8',
      );
    }
    return {
      outcome: 'success' as const,
      exitPath: 'done' as const,
      summary: 'mocked',
      transcriptDir: '',
      filesTouched: [],
      commit: null,
      stats: {
        exitPath: 'done' as const,
        turnsUsed: 3,
        maxTurns: 40,
        repairCyclesUsed: 0,
        maxRepairCycles: 5,
        tokensIn: 1000,
        tokensOut: 200,
        perTurn: [],
        durationMs: 1234,
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

async function reportJson(repo: string): Promise<{ stages: { name: string; status: string }[] }> {
  return JSON.parse(await readFile(path.join(repo, '.copperhead', 'runs', 'report.json'), 'utf8'));
}

async function reportCommitMessages(repo: string): Promise<string[]> {
  const { stdout } = await execa('git', ['log', '--format=%s'], { cwd: repo });
  return stdout.split('\n').filter((l) => l.startsWith('copperhead: run report'));
}

describe('stage-boundary REPORT.md/report.json regeneration (AC-16.4)', () => {
  it('regenerates the report at stage start (written, not committed) and commits it at stage success', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      sawRunningAtCallTime.length = 0;
      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, '# A tiny device\n', 'utf8');
      const res = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: () => {} });
      // halts at part-selection/schematic (the mock never produces a BOM row
      // or schematic) — enough stages to exercise the boundary at least twice.
      expect(res.completed.length).toBeGreaterThanOrEqual(2);

      // The report was written (not committed — design note in create.ts:
      // a stage-start commit would run before that stage's own gitPreflight
      // has ever validated the repo) before each stage's runAgentLoop call.
      expect(sawRunningAtCallTime.length).toBeGreaterThanOrEqual(2);
      expect(sawRunningAtCallTime.every(Boolean)).toBe(true);

      // Exactly one commit per completed stage — at success, never at start.
      const messages = await reportCommitMessages(repo);
      expect(messages).toContain('copperhead: run report spec-seed');
      expect(messages).toContain('copperhead: run report architecture');
      expect(messages.filter((m) => m === 'copperhead: run report spec-seed')).toHaveLength(1);
      expect(messages.some((m) => m.includes('(start)'))).toBe(false);

      const report = await reportJson(repo);
      const specSeed = report.stages.find((s) => s.name === 'spec-seed')!;
      expect(specSeed.status).toBe('ran');
    } finally {
      await cleanup();
    }
  });

  it('a mocked-success run never reports a stage as "stalled" or an unexpected status (regression guard for the PR#149 conflation bug)', async () => {
    // Retitled after review: the previous version of this test asserted
    // `status === 'ran' || status === 'running'` against a *finished*
    // report, which passes even if `StageCost.running` were deleted
    // outright (every row would just be 'ran') — it proved nothing about
    // in-flight rendering. That property is what the previous test's
    // `sawRunningAtCallTime` actually demonstrates, by reading report.json
    // from inside the mock at call time, before the stage resolves. This
    // test instead guards a real, distinct invariant on the finished
    // report: a status is only ever 'resumed', 'running', or 'ran' — never
    // a leaked 'stalled' placeholder, the exact class of bug PR#149 had in
    // its per-run metrics.json.
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, '# A tiny device\n', 'utf8');
      await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: () => {} });
      const report = await reportJson(repo);
      expect(report.stages.length).toBeGreaterThan(0);
      expect(report.stages.every((s) => s.status !== 'stalled')).toBe(true);
      expect(report.stages.every((s) => ['resumed', 'running', 'ran'].includes(s.status))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('commitRunArtifacts: false skips the report commits but the report is still written', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(path.join(repo, '.copperhead', 'config.json'), JSON.stringify({ commitRunArtifacts: false }), 'utf8');
      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, '# A tiny device\n', 'utf8');
      await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: () => {} });
      const messages = await reportCommitMessages(repo);
      expect(messages).toHaveLength(0);
      const report = await reportJson(repo);
      expect(report.stages.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });
});
