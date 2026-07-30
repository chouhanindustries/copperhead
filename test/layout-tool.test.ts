import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { runInit } from '../src/memory/scaffold.js';
import { loadConfig } from '../src/config.js';
import { availableTools, dispatchTool, type RunContext } from '../src/agent/tools.js';
import { ObligationsLedger } from '../src/agent/ledger.js';
import { Transcript } from '../src/agent/transcript.js';
import { saveConstraints } from '../src/memory/constraints.js';
import { tempFixtureRepo, REFERENCE_BOARD, REFERENCE_CONSTRAINTS } from './helpers.js';

async function makeCtx(repo: string): Promise<RunContext> {
  const transcript = new Transcript(repo);
  await transcript.init();
  return {
    repoRoot: repo,
    config: await loadConfig(repo),
    transcript,
    ledger: new ObligationsLedger(),
    runId: 'test-run',
    interactive: false,
    confirm: async () => true,
    editsUnlocked: false,
    changeId: null,
    proposalValidated: false,
    filesTouched: new Set(),
    decisions: [],
    lastErc: null,
    lastDrc: null,
    repairCycles: 0,
    finishRequest: null,
  };
}

describe('layout_metrics tool', () => {
  it('needs no edit unlock', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      expect(ctx.editsUnlocked).toBe(false);
      expect(availableTools(ctx).map((t) => t.schema.name)).toContain('layout_metrics');
    } finally {
      await cleanup();
    }
  });

  it('says the check does not apply yet when no board is configured', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      ctx.config = { ...ctx.config, board: null };
      const res = await dispatchTool(ctx, 'layout_metrics', {});
      expect(res).toContain('does not apply yet');
      expect(res).not.toMatch(/^error:/);
    } finally {
      await cleanup();
    }
  });

  it('reports the hard table, the soft metrics and the score for the configured board', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      const board = ctx.config.board!;
      await copyFile(REFERENCE_BOARD, path.join(repo, board));
      await saveConstraints(repo, REFERENCE_CONSTRAINTS);

      const res = await dispatchTool(ctx, 'layout_metrics', {});
      expect(res).toContain(`layout score: 93.4/100 for ${board}`);
      expect(res).toContain('Routed nets: 40/40');
      for (const key of Object.keys(REFERENCE_CONSTRAINTS)) expect(res).toContain(`[pass] ${key}`);
      expect(res).toContain('unrouted nets: none');

      // The scorer reads the board file, not the agent's account of it: degrade
      // the board on disk and the very next call reports the degradation.
      const text = await readFile(path.join(repo, board), 'utf8');
      await writeFile(path.join(repo, board), text.replace(/\(width 1\.5\)/g, '(width 0.25)'), 'utf8');
      const after = await dispatchTool(ctx, 'layout_metrics', {});
      expect(after).toContain('[fail] mech.load_trace_width_mm');
      expect(after).not.toContain('layout score: 93.4/100');
    } finally {
      await cleanup();
    }
  });

  it('reports no hard rows when the registry holds nothing measurable', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      await copyFile(REFERENCE_BOARD, path.join(repo, ctx.config.board!));
      await saveConstraints(repo, {
        'power.sleep_current_uA': { max: 10, source: 'docs/SPEC.md', affects: ['schematic'] },
      });
      const res = await dispatchTool(ctx, 'layout_metrics', {});
      expect(res).toContain('hard constraints:\n  (none:');
      expect(res).toContain('layout score:');
    } finally {
      await cleanup();
    }
  });
});
