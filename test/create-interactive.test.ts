import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { RunOptions } from '../src/agent/loop.js';
import { tempFixtureRepo } from './helpers.js';

const mockConfirmTty = vi.hoisted(() => vi.fn(async () => false));

vi.mock('../src/util/prompt.js', () => ({
  confirmTty: mockConfirmTty,
}));

const mockRunAgentLoop = vi.hoisted(() =>
  vi.fn(async (opts: RunOptions) => {
    const { mkdir: mkdirFs, writeFile: writeFileFs } = await import('node:fs/promises');
    const { default: pathMod } = await import('node:path');
    const docs = pathMod.join(opts.repoRoot, 'docs');
    await mkdirFs(docs, { recursive: true });
    
    // Fulfill contracts for stages we care about to simulate completion
    if (opts.request.includes('spec-seed'))
      await writeFileFs(pathMod.join(docs, 'SPEC.md'), '# spec\n\n## Budgets\n', 'utf8');
    if (opts.request.includes('architecture'))
      await writeFileFs(pathMod.join(docs, 'SUBSYSTEMS.md'), '# subsystems\n', 'utf8');
    if (opts.request.includes('part-selection'))
      await writeFileFs(pathMod.join(docs, 'BOM.md'), '# bom\n', 'utf8');
      
    // Mocking an empty board footprint for layout-draft completion
    if (opts.request.includes('layout-draft')) {
      const pcbFile = pathMod.join(opts.repoRoot, 'hardware', 'test.kicad_pcb');
      await mkdirFs(pathMod.dirname(pcbFile), { recursive: true });
      await writeFileFs(pcbFile, '(kicad_pcb (version 20240108) (footprint "Resistor_SMD:R_0402"))', 'utf8');
      await writeFileFs(pathMod.join(docs, 'LAYOUT.md'), '# Layout\n\n## Draft quality\n', 'utf8');
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
        turnsUsed: 1,
        maxTurns: 40,
        repairCyclesUsed: 0,
        maxRepairCycles: 5,
        tokensIn: 100,
        tokensOut: 20,
        perTurn: [],
        durationMs: 123,
      },
      cacheHits: 0,
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
// We also need to mock KiCad CLI so `schematic` and `layout-draft` tests don't fail without KiCad
vi.mock('../src/kicad/cli.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runErc: async () => ({ ok: true, violations: [], rules: {} }),
  runDrc: async () => ({ ok: true, violations: [], rules: {} }),
  exportSvg: async () => {},
}));
// And listSymbols for the schematic stage
vi.mock('../src/kicad/sexp.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listSymbols: async () => [{ ref: 'R1', value: '10k', footprint: 'Resistor_SMD:R_0402', uuid: '0001', sheetName: '1', sheetPath: '/' }],
}));
vi.mock('../src/memory/drift.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  checkDrift: async () => [],
}));

import { runCreate } from '../src/commands/create.js';

describe('create pipeline interactive mode (Task 9.8)', () => {
  beforeEach(() => {
    mockConfirmTty.mockClear();
    mockRunAgentLoop.mockClear();
  });

  it('stops at the spec-approval gate when the user declines to proceed', async () => {
    mockConfirmTty.mockImplementation(async () => false);

    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(path.join(repo, '.copperhead', 'config.json'), JSON.stringify({}), 'utf8');
      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, '# A tiny device\n', 'utf8');
      const lines: string[] = [];

      const res = await runCreate({
        repoRoot: repo,
        briefPath,
        model: 'gpt-5',
        interactive: true,
        log: (s) => lines.push(s),
      });

      // Pipeline gracefully stops after spec-seed (which is stage 1)
      expect(res.ok).toBe(true);
      expect(res.completed).toEqual(['spec-seed']);
      
      const out = lines.join('\n');
      expect(out).toContain('stage spec-seed: interactive checkpoint');
      expect(out).toContain('stopped at stage 2/8 (architecture)');
      
      // confirmTty was called once
      expect(mockConfirmTty).toHaveBeenCalledTimes(1);
      expect(mockConfirmTty.mock.calls[0][0]).toContain('Proceed to the next stage (architecture)?');
    } finally {
      await cleanup();
    }
  });

  it('resumes from where it left off, testing the pre-export gate', async () => {
    mockConfirmTty.mockImplementation(async () => false);

    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const docs = path.join(repo, 'docs');
      await mkdir(docs, { recursive: true });
      
      // Simulate that stages 1 through 4 are already complete
      await writeFile(path.join(docs, 'SPEC.md'), '# spec\n\n## Budgets\n', 'utf8');
      await writeFile(path.join(docs, 'SUBSYSTEMS.md'), '# subsystems\n', 'utf8');
      await writeFile(path.join(docs, 'BOM.md'), '# bom\n', 'utf8');
      // For stage 4 (schematic) completion we need config.schematic to exist
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(path.join(repo, '.copperhead', 'config.json'), JSON.stringify({
        schematic: 'hardware/test.kicad_sch',
        board: 'hardware/test.kicad_pcb'
      }), 'utf8');
      const schFile = path.join(repo, 'hardware', 'test.kicad_sch');
      await mkdir(path.dirname(schFile), { recursive: true });
      await writeFile(schFile, '(kicad_sch)', 'utf8');

      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, '# A tiny device\n', 'utf8');
      const lines: string[] = [];

      const res = await runCreate({
        repoRoot: repo,
        briefPath,
        model: 'gpt-5',
        interactive: true,
        log: (s) => lines.push(s),
      });

      // Pipeline resumes at stage 5 (layout-draft), completes it, then hits the pre-export gate
      expect(res.ok).toBe(true);
      expect(res.completed).toEqual(['spec-seed', 'architecture', 'part-selection', 'schematic', 'layout-draft']);
      
      const out = lines.join('\n');
      expect(out).toContain('stage spec-seed: already complete');
      expect(out).toContain('stage architecture: already complete');
      expect(out).toContain('stage layout-draft: interactive checkpoint');
      expect(out).toContain('stopped at stage 6/8 (outputs)');
      
      expect(mockConfirmTty).toHaveBeenCalledTimes(1);
      expect(mockConfirmTty.mock.calls[0][0]).toContain('Proceed to the next stage (outputs)?');
    } finally {
      await cleanup();
    }
  });
});
