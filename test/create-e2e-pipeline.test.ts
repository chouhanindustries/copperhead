import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { RunOptions, RunResult } from '../src/agent/loop.js';
import type { SchematicSymbol } from '../src/kicad/sexp.js';
import type { CheckReport } from '../src/kicad/report.js';
import type { DriftMismatch } from '../src/memory/drift.js';
import type { CheckResult } from '../src/commands/check.js';
import { tempFixtureRepo } from './helpers.js';

const STAGES = ['spec-seed', 'architecture', 'part-selection', 'schematic', 'layout-draft', 'outputs', 'firmware', 'devplan'] as const;

function stagePrompt(req: string): string | undefined {
  for (const s of STAGES) {
    if (req.includes(s)) return s;
  }
  return undefined;
}

function stageArtifactRoot(repoRoot: string, stage: string): string {
  return path.join(repoRoot, '.copperhead', 'test-artifacts', stage);
}

async function recordArtifact(repoRoot: string, stage: string, name: string, content: string): Promise<void> {
  const dir = stageArtifactRoot(repoRoot, stage);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), content, 'utf8');
}

const mockRunAgentLoop = vi.hoisted(() =>
  vi.fn(async (opts: RunOptions): Promise<RunResult> => {
    const { mkdir: mkdirFs, writeFile: writeFileFs, readFile: readFileFs } = await import('node:fs/promises');
    const { existsSync: exists } = await import('node:fs');
    const pathMod = await import('node:path');

    const repoRoot = opts.repoRoot;
    const docs = pathMod.join(repoRoot, 'docs');
    await mkdirFs(docs, { recursive: true });
    const stage = stagePrompt(opts.request);

    if (stage === 'spec-seed') {
      await writeFileFs(
        pathMod.join(docs, 'SPEC.md'),
        [
          `# A Tiny Device`,
          ``,
          `## Budgets`,
          ``,
          `- sleep_current_uA: 25`,
          `- peak_current_mA: 500`,
          ``,
          `## Assumptions`,
          ``,
          `- USB-C assumed ASSUMED`,
          ``,
        ].join('\n'),
        'utf8',
      );
    }

    if (stage === 'architecture') {
      await writeFileFs(
        pathMod.join(docs, 'SUBSYSTEMS.md'),
        [
          `# Subsystems`,
          ``,
          `## Power`,
          ``,
          `LDO regulator, 3.3 V output, 300 mA max.`,
          ``,
          `## MCU`,
          ``,
          `ESP32-S3 module for BLE + Wi-Fi connectivity.`,
          ``,
        ].join('\n'),
        'utf8',
      );
    }

    if (stage === 'part-selection') {
      await writeFileFs(
        pathMod.join(docs, 'BOM.md'),
        [
          `# Bill of Materials`,
          ``,
          `| Refdes | Value | Footprint | MPN | Rationale |`,
          `|---|---|---|---|---|`,
          `| R1 | 10k | R_0603 | RC0603FR-0710KL | bias resistor |`,
          `| C1 | 100n | C_0603 | CL10B104KB8NNNC | decoupling |`,
          `| U1 | ESP32-S3 | ESP32-S3-MINI-1 | ESP32-S3-MINI-1-N8 | BLE+Wi-Fi |`,
          ``,
        ].join('\n'),
        'utf8',
      );
    }

    if (stage === 'schematic') {
      // Overwrite the empty bootstrap schematic with one that has real symbols
      const configPath = pathMod.join(repoRoot, '.copperhead', 'config.json');
      if (exists(configPath)) {
        const cfg = JSON.parse(await readFileFs(configPath, 'utf8'));
        const schPath = pathMod.join(repoRoot, cfg.schematic);
        if (exists(schPath)) {
          await writeFileFs(
            schPath,
            [
              `(kicad_sch`,
              `	(version 20231120)`,
              `	(generator "eeschema")`,
              `	(generator_version "8.0")`,
              `	(uuid "00000000-0000-0000-0000-000000000000")`,
              `	(paper "A4")`,
              `	(lib_symbols`,
              `		(symbol "R" (in_bom yes) (on_board yes)`,
              `			(property "Reference" "R" (id 0) (at (0 0) 0)`,
              `				(effects (font (size 1.27 1.27))))`,
              `			(property "Value" "R" (id 1) (at (0 0) 0)`,
              `				(effects (font (size 1.27 1.27))))`,
              `			(symbol "R_0_1"`,
              `				(rectangle (start -2.54 1.27) (end 2.54 -1.27)`,
              `					(stroke (width 0.254) (type default))`,
              `					(fill (type none))))`,
              `			(pin (number "1") (name "~") (at (-5.08 0) 0) (length 2.54)`,
              `				(electrical passive))`,
              `			(pin (number "2") (name "~") (at (5.08 0) 0) (length 2.54)`,
              `				(electrical passive))`,
              `		)`,
              `	)`,
              `	(symbol (lib_id "R") (at (50.8 50.8) 0)`,
              `		(property "Reference" "R1" (id 0) (at (50.8 50.8) 0)`,
              `			(effects (font (size 1.27 1.27)) (justify left)))`,
              `		(property "Value" "10k" (id 1) (at (50.8 50.8) 0)`,
              `			(effects (font (size 1.27 1.27)) (justify left)))`,
              `		(property "Footprint" "Resistor_SMD:R_0603_1608Metric" (id 2) (at (50.8 50.8) 0)`,
              `			(effects (font (size 1.27 1.27)) (justify left)))`,
              `		(instances`,
              `			(path "/" (reference "R1"))`,
              `		)`,
              `	)`,
              `	(symbol (lib_id "R") (at (101.6 50.8) 0)`,
              `		(property "Reference" "R2" (id 0) (at (101.6 50.8) 0)`,
              `			(effects (font (size 1.27 1.27)) (justify left)))`,
              `		(property "Value" "10k" (id 1) (at (101.6 50.8) 0)`,
              `			(effects (font (size 1.27 1.27)) (justify left)))`,
              `		(property "Footprint" "Resistor_SMD:R_0603_1608Metric" (id 2) (at (101.6 50.8) 0)`,
              `			(effects (font (size 1.27 1.27)) (justify left)))`,
              `		(instances`,
              `			(path "/" (reference "R2"))`,
              `		)`,
              `	)`,
              `	(sheet_instances`,
              `		(path "/" (page "1"))`,
              `	)`,
              `)`,
              ``,
            ].join('\n'),
            'utf8',
          );
        }
      }
    }

    if (stage === 'layout-draft') {
      const configPath = pathMod.join(repoRoot, '.copperhead', 'config.json');
      if (exists(configPath)) {
        const cfg = JSON.parse(await readFileFs(configPath, 'utf8'));
        const boardPath = pathMod.join(repoRoot, cfg.board);
        if (exists(boardPath)) {
          const boardContent = await readFileFs(boardPath, 'utf8');
          const patched = boardContent.replace(
            `(net 0 "")`,
            `(net 0 "")\n	(footprint "Resistor_SMD:R_0603_1608Metric" (layer "F.Cu") (at (0 0) 0) (descr "0603 resistor")`,
          );
          await writeFileFs(boardPath, patched, 'utf8');
        }
      }
      await writeFileFs(
        pathMod.join(docs, 'LAYOUT.md'),
        `# Layout\n\n## Draft quality\n\nPlaceholders positioned, no routing yet.\n`,
        'utf8',
      );
    }

    if (stage === 'outputs') {
      const outDir = pathMod.join(repoRoot, 'outputs');
      await mkdirFs(outDir, { recursive: true });
      await writeFileFs(pathMod.join(outDir, 'board-F_Cu.gbr'), 'G04 Gerber*\n', 'utf8');
      await writeFileFs(pathMod.join(outDir, 'board-B_Cu.gbr'), 'G04 Gerber*\n', 'utf8');
    }

    if (stage === 'firmware') {
      const fwDir = pathMod.join(repoRoot, 'firmware');
      await mkdirFs(fwDir, { recursive: true });
      await writeFileFs(
        pathMod.join(fwDir, 'main.c'),
        '#include "pins.h"\nint main(void) { return 0; }\n',
        'utf8',
      );
    }

    if (stage === 'devplan') {
      await writeFileFs(
        pathMod.join(docs, 'DEVPLAN.md'),
        [
          `# Development Plan`,
          ``,
          `## Bring-up steps`,
          ``,
          `1. Power on, measure 3.3 V rail.`,
          `2. Flash firmware via USB-C.`,
          ``,
          `## Test points`,
          ``,
          `TP1: 3.3 V rail. TP2: GND.`,
          ``,
        ].join('\n'),
        'utf8',
      );
    }

    return {
      outcome: 'success' as const,
      exitPath: 'done' as const,
      summary: `mocked ${stage ?? 'unknown'}`,
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
        durationMs: 1000,
      },
      cacheHits: 1,
    };
  }),
);

// Module-level mocks
vi.mock('../src/agent/loop.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runAgentLoop: mockRunAgentLoop,
}));

vi.mock('../src/kicad/cli.js', () => ({
  runErc: vi.fn(async (): Promise<CheckReport> => ({ ok: true, source: 'erc', violations: [] })),
  runDrc: vi.fn(async (): Promise<CheckReport> => ({ ok: true, source: 'drc', violations: [] })),
  exportSvg: vi.fn(async () => ''),
  kicadCliVersion: vi.fn(async () => '8.0.0'),
  resolveKicadCli: vi.fn(() => 'kicad-cli'),
}));

vi.mock('../src/kicad/sexp.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/kicad/sexp.js')>();
  return {
    ...original,
    listSymbols: vi.fn(original.listSymbols),
  };
});

vi.mock('../src/memory/drift.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  checkDrift: vi.fn(async (): Promise<DriftMismatch[]> => []),
  emptySchematicWarning: vi.fn(async (): Promise<string | null> => null),
}));

vi.mock('../src/commands/check.js', () => ({
  runCheck: vi.fn(async (): Promise<CheckResult> => ({
    ok: true,
    erc: { ok: true, violations: 0 },
    drc: { ok: true, violations: 0 },
    drift: { ok: true, mismatches: [] },
    openspec: null,
    constraints: { ok: true, violations: [] },
  })),
}));

vi.mock('../src/openspec/cli.js', () => ({
  openspecInit: vi.fn(async () => ({ ok: true, output: 'mocked' })),
  openspecValidate: vi.fn(async () => ({ ok: true, output: 'mocked' })),
  openspecArchive: vi.fn(async () => ({ ok: true, output: 'mocked' })),
}));

vi.mock('../src/util/preflight.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertDiskSpace: vi.fn(async () => {}),
}));

import { runCreate } from '../src/commands/create.js';

describe('create pipeline — end-to-end (mocked provider)', () => {
  beforeEach(() => {
    mockRunAgentLoop.mockClear();
  });

  it('completes all 8 stages on a clean run', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, '# A tiny device\n\nA USB-C power breakout board.\n', 'utf8');

      const lines: string[] = [];
      const res = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: (s) => lines.push(s) });

      expect(res.ok).toBe(true);
      expect(res.completed).toEqual([...STAGES]);

      // Each stage was invoked exactly once
      const stageNames = mockRunAgentLoop.mock.calls
        .map(([opts]) => stagePrompt(opts.request))
        .filter(Boolean);
      expect(stageNames).toEqual([...STAGES]);

      // Pipeline-accumulated output
      const out = lines.join('\n');
      expect(out).toContain('create pipeline complete');
      expect(out).toContain('Per-stage cost summary');
    } finally {
      await cleanup();
    }
  });

  it('completes all 8 stages and produces a run report', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, '# A tiny device\n\nA USB-C power breakout board.\n', 'utf8');

      const lines: string[] = [];
      const res = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: (s) => lines.push(s) });

      expect(res.ok).toBe(true);

      // Run report artifacts exist
      const reportMd = await readFile(path.join(repo, '.copperhead', 'runs', 'REPORT.md'), 'utf8');
      expect(reportMd).toContain('Copperhead run report');
      for (const s of STAGES) {
        expect(reportMd).toContain(s);
      }

      const reportJson = JSON.parse(
        await readFile(path.join(repo, '.copperhead', 'runs', 'report.json'), 'utf8'),
      );
      expect(reportJson.stageCount).toBe(8);
      expect(reportJson.ran).toBe(8);
      expect(reportJson.resumed).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('stops when a stage (schematic) receives a false-green ERC gate but no real symbols', async () => {
    // Re-configure the runErc mock to return ok despite no symbols in the schematic.
    // The mock agent writes an empty schematic, but runErc returns ok (false green).
    // Since listSymbols is NOT mocked at module level (we rely on real parsing), the
    // schematic stage completion check sees: 0 symbols + drift mismatch → stage fails.
    //
    // Override listSymbols for this test to return empty (simulating an empty schematic
    // even though the file has symbols), so the false-green behavior is triggered:
    // runErc says ok, but isComplete says false.
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, '# A tiny device\n\nA USB-C power breakout board.\n', 'utf8');

    // Override mock to return empty symbols — simulating a false-green ERC
    // on a schematic that has no real content
    const { listSymbols } = await import('../src/kicad/sexp.js');
    vi.mocked(listSymbols).mockResolvedValueOnce([]);

      const lines: string[] = [];
      const res = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: (s) => lines.push(s) });

      // Pipeline stops at schematic stage, no further stages run
      expect(res.ok).toBe(false);
      expect(res.completed).toEqual(['spec-seed', 'architecture', 'part-selection']);
      expect(res.completed).not.toContain('schematic');

      const out = lines.join('\n');
      // Resume point printed
      expect(out).toContain('stopped at stage 4/8 (schematic)');
    } finally {
      await cleanup();
    }
  });

  it('stops when the agent returns failure (wedged stage)', async () => {
    mockRunAgentLoop.mockImplementationOnce(async (opts: RunOptions): Promise<RunResult> => {
      const { mkdir: mkdirFs, writeFile: writeFileFs } = await import('node:fs/promises');
      const pathMod = await import('node:path');
      const docs = pathMod.join(opts.repoRoot, 'docs');
      await mkdirFs(docs, { recursive: true });
      await writeFileFs(
        pathMod.join(docs, 'SPEC.md'),
        '# Spec\n\n## Budgets\n\n- sleep_current_uA: 25\n',
        'utf8',
      );
      return {
        outcome: 'failure' as const,
        exitPath: 'error' as const,
        summary: 'mocked failure — tool call timed out',
        transcriptDir: '',
        filesTouched: [],
        commit: null,
        stats: {
          exitPath: 'error' as const,
          turnsUsed: 1,
          maxTurns: 40,
          repairCyclesUsed: 0,
          maxRepairCycles: 5,
          tokensIn: 100,
          tokensOut: 50,
          perTurn: [],
          durationMs: 500,
        },
        cacheHits: 0,
      };
    });

    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, '# A tiny device\n\nA USB-C power breakout board.\n', 'utf8');

      const lines: string[] = [];
      const res = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: (s) => lines.push(s) });

      // Pipeline should stop at spec-seed (first stage) since agent returned failure
      expect(res.ok).toBe(false);
      expect(res.completed).toEqual([]);

      const out = lines.join('\n');
      expect(out).toContain('stopped at stage');
    } finally {
      await cleanup();
    }
  });

  it('resumes past completed stages on a re-run', async () => {
    // Run once: completes only spec-seed (first stage mock produces a failure)
    mockRunAgentLoop
      .mockImplementationOnce(async (opts: RunOptions): Promise<RunResult> => {
        const { mkdir: mkdirFs, writeFile: writeFileFs } = await import('node:fs/promises');
        const pathMod = await import('node:path');
        const docs = pathMod.join(opts.repoRoot, 'docs');
        await mkdirFs(docs, { recursive: true });
        await writeFileFs(
          pathMod.join(docs, 'SPEC.md'),
          '# Spec\n\n## Budgets\n\n- sleep_current_uA: 25\n',
          'utf8',
        );
        return {
          outcome: 'success' as const,
          exitPath: 'done' as const,
          summary: 'mocked spec-seed',
          transcriptDir: '',
          filesTouched: [],
          commit: null,
          stats: { exitPath: 'done' as const, turnsUsed: 2, maxTurns: 40, repairCyclesUsed: 0, maxRepairCycles: 5, tokensIn: 500, tokensOut: 100, perTurn: [], durationMs: 500 },
          cacheHits: 0,
        };
      })
      .mockImplementationOnce(async (opts: RunOptions): Promise<RunResult> => {
        // This is the architecture stage — deliberately fail it
        return {
          outcome: 'failure' as const,
          exitPath: 'error' as const,
          summary: 'mocked failure',
          transcriptDir: '',
          filesTouched: [],
          commit: null,
          stats: { exitPath: 'error' as const, turnsUsed: 1, maxTurns: 40, repairCyclesUsed: 0, maxRepairCycles: 5, tokensIn: 100, tokensOut: 50, perTurn: [], durationMs: 500 },
          cacheHits: 0,
        };
      });

    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, '# A tiny device\n\nA USB-C power breakout board.\n', 'utf8');

      const res1 = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: () => {} });
      expect(res1.ok).toBe(false);
      expect(res1.completed).toEqual(['spec-seed']); // spec-seed succeeded, architecture failed

      // The first stage (spec-seed) was a success, so its docs should be committed.
      // But wait — the mock returns commit: null, so runCreate doesn't commit. The
      // test driver should commit manually to simulate the real pipeline behavior;
      // the mock cannot because module-scope execa.mock is not set up here.
      // Instead, force-commit the stage-1 output so stage 1 is detected as complete
      // on the resume.
      const { execa } = await import('execa');
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'stage 1 output'], { cwd: repo });

      // Reset mock for resume run — should skip spec-seed and re-attempt architecture
      mockRunAgentLoop.mockClear();
      // On resume, architecture should be attempted again
      mockRunAgentLoop.mockImplementation(async (opts: RunOptions): Promise<RunResult> => {
        const { mkdir: mkdirFs, writeFile: writeFileFs } = await import('node:fs/promises');
        const pathMod = await import('node:path');
        const docs = pathMod.join(opts.repoRoot, 'docs');
        await mkdirFs(docs, { recursive: true });
        // Write SUBSYSTEMS.md to make architecture pass this time
        await writeFileFs(
          pathMod.join(docs, 'SUBSYSTEMS.md'),
          '# Subsystems\n\n## Power\n\nLDO, 3.3 V, 300 mA.\n',
          'utf8',
        );
        return {
          outcome: 'success' as const,
          exitPath: 'done' as const,
          summary: 'mocked architecture',
          transcriptDir: '',
          filesTouched: [],
          commit: null,
          stats: { exitPath: 'done' as const, turnsUsed: 3, maxTurns: 40, repairCyclesUsed: 0, maxRepairCycles: 5, tokensIn: 500, tokensOut: 200, perTurn: [], durationMs: 800 },
          cacheHits: 0,
        };
      });

      const res2 = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: () => {} });
      // The pipeline resumes: spec-seed is skipped (already committed), architecture runs.
      // But since the later stages have no artifacts, pipeline stops at part-selection.
      expect(res2.completed).toContain('spec-seed'); // resumed
      expect(res2.completed).toContain('architecture'); // ran fresh
      expect(res2.completed).not.toContain('schematic');

      // Only architecture should have been a real call
      const calls = mockRunAgentLoop.mock.calls.map(([opts]) => opts.request);
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls.some((r) => r.includes('architecture'))).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
