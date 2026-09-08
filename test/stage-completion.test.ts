/**
 * Unit tests for the strengthened stage isComplete probes (issue #23).
 *
 * Each probe is exercised against:
 *   1. A false-positive case — scaffold / init template / blank file → false
 *   2. A true-positive case  — real agent-produced content         → true
 *
 * The STAGES array is imported directly so we always test the live contracts,
 * not a copy.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';

const runDrcMock = vi.hoisted(() => vi.fn());
vi.mock('../src/kicad/cli.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/kicad/cli.js')>()),
  runDrc: runDrcMock,
}));

import { STAGES } from '../src/commands/create.js';
import { writeExportReceipt } from '../src/kicad/export-receipt.js';
import { requiredFabArtifacts } from '../src/kicad/cli.js';

/** Return the isComplete function for the named stage (throws if not found). */
function stageNamed(name: string) {
  const s = STAGES.find((x) => x.name === name);
  if (!s) throw new Error(`Stage not found: ${name}`);
  return s.isComplete;
}

/** Create a fresh temp dir, run the callback, then remove it. */
async function withTmpDir(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = path.join(
    os.tmpdir(),
    `copperhead-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const DOCS = 'docs';

async function writeBoardConfig(root: string, schematic: string | null = null): Promise<void> {
  await mkdir(path.join(root, '.copperhead'), { recursive: true });
  await mkdir(path.join(root, 'hardware'), { recursive: true });
  await writeFile(
    path.join(root, '.copperhead', 'config.json'),
    JSON.stringify({ board: 'hardware/board.kicad_pcb', schematic, docs: DOCS }),
    'utf8',
  );
  await writeFile(
    path.join(root, 'hardware', 'board.kicad_pcb'),
    '(kicad_pcb\n  (layers\n    (0 "F.Cu" signal)\n    (31 "B.Cu" signal)\n    (36 "B.Silkscreen" user)\n    (37 "F.Silkscreen" user)\n    (38 "B.Mask" user)\n    (39 "F.Mask" user)\n    (44 "Edge.Cuts" user)\n  )\n  (footprint "Fixture:Part")\n)\n',
    'utf8',
  );
  if (schematic) await writeFile(path.join(root, schematic), '(kicad_sch)\n', 'utf8');
  await mkdir(path.join(root, DOCS), { recursive: true });
  await writeFile(path.join(root, DOCS, 'BOM.md'), '# BOM\n\n| Refdes | MPN |\n|---|---|\n| R1 | RC0603 |\n', 'utf8');
}

async function writeCompleteOutputs(root: string, withSchematic = false, withReceipt = true): Promise<void> {
  const out = path.join(root, 'outputs');
  await mkdir(path.join(out, 'gerbers'), { recursive: true });
  const gerberRows = [
    ['board-F_Cu.gtl', 'Copper,L1,Top'],
    ['board-B_Cu.gbl', 'Copper,L2,Bot'],
    ['board-F_Mask.gts', 'SolderMask,Top'],
    ['board-B_Mask.gbs', 'SolderMask,Bot'],
    ['board-F_Silkscreen.gto', 'Legend,Top'],
    ['board-B_Silkscreen.gbo', 'Legend,Bot'],
    ['board-Edge_Cuts.gm1', 'Profile'],
  ];
  for (const [name, fileFunction] of gerberRows) {
    await writeFile(path.join(out, 'gerbers', name!), `%TF.FileFunction,${fileFunction}*%\n`, 'utf8');
  }
  await writeFile(
    path.join(out, 'gerbers', 'board-job.gbrjob'),
    JSON.stringify({ FilesAttributes: gerberRows.map(([Path, FileFunction]) => ({ Path, FileFunction })) }),
    'utf8',
  );
  await writeFile(path.join(out, 'gerbers', 'board-PTH.drl'), 'M48\n', 'utf8');
  await writeFile(path.join(out, 'outline.dxf'), 'SECTION\n', 'utf8');
  await writeFile(path.join(out, 'board.step'), 'ISO-10303-21;\n', 'utf8');
  await writeFile(path.join(out, 'board.svg'), '<svg/>\n', 'utf8');
  await writeFile(path.join(out, 'BOM.csv'), 'refdes,mpn,qty\nR1,RC0603,1\n', 'utf8');
  if (withSchematic) {
    await mkdir(path.join(out, 'renders'), { recursive: true });
    await writeFile(path.join(out, 'renders', 'schematic.svg'), '<svg/>\n', 'utf8');
  }
  if (withReceipt) {
    await writeExportReceipt({
      repoRoot: root,
      board: 'hardware/board.kicad_pcb',
      schematic: withSchematic ? 'hardware/design.kicad_sch' : null,
      bom: 'docs/BOM.md',
      artifacts: requiredFabArtifacts(withSchematic),
    });
  }
}

beforeEach(() => {
  runDrcMock.mockReset();
  runDrcMock.mockResolvedValue({ ok: true, source: 'drc', violations: [] });
});

// ---------------------------------------------------------------------------
// Stage 1: spec-seed
// ---------------------------------------------------------------------------
describe('spec-seed isComplete', () => {
  it('returns false when SPEC.md has only the init scaffold placeholder (## Budgets + HTML comment)', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      // Exact content that `copperhead init` writes
      await writeFile(
        path.join(root, DOCS, 'SPEC.md'),
        `# My Project — Specification\n\nWhat the device is.\n\n## Budgets\n\n<!-- Add hard budgets here -->\n<!-- - sleep_current_uA: 25 -->\n\n## Assumptions\n\n<!-- Decisions flagged ASSUMED -->\n`,
        'utf8',
      );
      expect(await stageNamed('spec-seed')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when SPEC.md has no Budgets section at all', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(path.join(root, DOCS, 'SPEC.md'), '# Spec\n\nNo budgets section.\n', 'utf8');
      expect(await stageNamed('spec-seed')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when SPEC.md is missing', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      expect(await stageNamed('spec-seed')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when SPEC.md Budgets section contains multi-line HTML comments only', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'SPEC.md'),
        `# My Project\n\n## Budgets\n\n<!--\nAdd hard budgets here\n- sleep_current_uA: 25\n-->\n\n## Assumptions\n`,
        'utf8',
      );
      expect(await stageNamed('spec-seed')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when SPEC.md Budgets heading has trailing title text and contains HTML comments only', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'SPEC.md'),
        `# My Project\n\n## 3. Budgets and constraints\n\n<!-- Add hard budgets here -->\n\n## Assumptions\n`,
        'utf8',
      );
      expect(await stageNamed('spec-seed')(root, DOCS)).toBe(false);
    });
  });

  it('returns true when SPEC.md has a Budgets section with real content lines', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'SPEC.md'),
        `# My Project\n\n## Budgets\n\n- sleep_current_uA: 25\n- peak_current_mA: 500\n\n## Assumptions\n\n- USB-C assumed ASSUMED\n`,
        'utf8',
      );
      expect(await stageNamed('spec-seed')(root, DOCS)).toBe(true);
    });
  });

  // I17: the budgets live under subsections, so the parent heading's own body is
  // empty. Ending the section at the next heading of ANY depth read this fully
  // populated spec as an unfilled placeholder and failed the stage after it had
  // already committed its work.
  it('returns true when the Budgets section carries its content in subsections', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'SPEC.md'),
        `# My Project\n\n## 3. Electrical budgets\n\n### 3.1 Input and rails\n\n| ID | Budget | Value |\n|----|--------|-------|\n| B-1 | VIN | 12 V |\n\n### 3.2 Battery\n\n- charge_current_mA: 500\n\n## 4. Motion requirements\n\n- 90 deg index\n`,
        'utf8',
      );
      expect(await stageNamed('spec-seed')(root, DOCS)).toBe(true);
    });
  });

  it('returns false when the Budgets section holds subheadings but no content', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'SPEC.md'),
        `# My Project\n\n## Budgets\n\n### Power\n\n<!-- TODO -->\n\n### Thermal\n\n## Assumptions\n`,
        'utf8',
      );
      expect(await stageNamed('spec-seed')(root, DOCS)).toBe(false);
    });
  });

  it('does not let a later sibling section satisfy the Budgets contract', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'SPEC.md'),
        `# My Project\n\n## Budgets\n\n<!-- Add hard budgets here -->\n\n## Assumptions\n\n- USB-C assumed ASSUMED\n`,
        'utf8',
      );
      expect(await stageNamed('spec-seed')(root, DOCS)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Stage 2: architecture
// ---------------------------------------------------------------------------
describe('architecture isComplete', () => {
  it('returns false when SUBSYSTEMS.md does not exist', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      expect(await stageNamed('architecture')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when SUBSYSTEMS.md has only a title heading and no section content', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      // A file with only a top-level heading and blank lines — no prose, no ## sections
      await writeFile(
        path.join(root, DOCS, 'SUBSYSTEMS.md'),
        `# Subsystems\n\n`,
        'utf8',
      );
      expect(await stageNamed('architecture')(root, DOCS)).toBe(false);
    });
  });

  it('returns false for untouched init scaffold SUBSYSTEMS.md output with auto-generated sheet symbol bullets', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      // Exact scaffold output generated by generateDocs() in src/memory/scaffold.ts
      await writeFile(
        path.join(root, DOCS, 'SUBSYSTEMS.md'),
        `# Subsystems\n\nPer-sheet values and reasoning (regulator, charger, RF, ...).\n\n## Sheet hardware\n\n- R1: 10k\n- U1: ESP32\n`,
        'utf8',
      );
      expect(await stageNamed('architecture')(root, DOCS)).toBe(false);
    });
  });

  it('returns false for untouched init scaffold SUBSYSTEMS.md output with unannotated symbol bullets (- U?: / - ?:)', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'SUBSYSTEMS.md'),
        `# Subsystems\n\nPer-sheet values and reasoning (regulator, charger, RF, ...).\n\n## Sheet hardware\n\n- U?: ESP32\n- ?: 10k\n- R?: 100n\n`,
        'utf8',
      );
      expect(await stageNamed('architecture')(root, DOCS)).toBe(false);
    });
  });

  it('returns true when SUBSYSTEMS.md has at least one section with prose content', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'SUBSYSTEMS.md'),
        `# Subsystems\n\n## Power\n\nLDO regulator, 3.3 V output, 300 mA max. Chosen for low quiescent current.\n\n## MCU\n\nESP32-S3 in MINI-1 module for BLE + Wi-Fi.\n`,
        'utf8',
      );
      expect(await stageNamed('architecture')(root, DOCS)).toBe(true);
    });
  });

  it('returns true when SUBSYSTEMS.md has bullet-styled subsystem reasoning lines', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'SUBSYSTEMS.md'),
        `# Subsystems\n\n## Power\n\n- Regulator: AP2112, 3.3V/600mA, chosen for low quiescent current\n- Battery: single-cell LiPo, protection via BQ24075\n`,
        'utf8',
      );
      expect(await stageNamed('architecture')(root, DOCS)).toBe(true);
    });
  });

  it('returns true when SUBSYSTEMS.md has voltage-led bullet reasoning lines (- 5V: / - 12V:)', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'SUBSYSTEMS.md'),
        `# Subsystems\n\n## Power\n\n- 5V: regulated rail from AP2112 LDO\n- 12V: input rail, fused\n`,
        'utf8',
      );
      expect(await stageNamed('architecture')(root, DOCS)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Stage 3: part-selection
// ---------------------------------------------------------------------------
describe('part-selection isComplete', () => {
  it('returns false when BOM.md does not exist', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      expect(await stageNamed('part-selection')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when BOM.md has no table rows', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(path.join(root, DOCS, 'BOM.md'), '# Bill of Materials\n\nEmpty.\n', 'utf8');
      expect(await stageNamed('part-selection')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when the canonical BOM contains only its header and separator', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'BOM.md'),
        `# Bill of Materials\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n`,
        'utf8',
      );
      expect(await stageNamed('part-selection')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when all BOM rows have UNVERIFIED MPNs (init scaffold)', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      // Exact scaffold output from bomTable() in scaffold.ts
      await writeFile(
        path.join(root, DOCS, 'BOM.md'),
        `# Bill of Materials\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| R1 | 10k | R_0603 | UNVERIFIED | extracted from schematic by copperhead init |\n| U1 | ESP32 | ESP32-S3-MINI-1 | UNVERIFIED | extracted from schematic by copperhead init |\n`,
        'utf8',
      );
      expect(await stageNamed('part-selection')(root, DOCS)).toBe(false);
    });
  });

  it('returns true for existing concrete MPNs whose UNVERIFIED flag was cleared by human review', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'BOM.md'),
        `# Bill of Materials\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| R1 | 10k | R_0603 | RC0603FR-0710KL | standard 1% bias |\n| U1 | ESP32 | ESP32-S3-MINI-1 | ESP32-S3-MINI-1-N8 | BLE + Wi-Fi module |\n`,
        'utf8',
      );
      expect(await stageNamed('part-selection')(root, DOCS)).toBe(true);
    });
  });

  it('returns true when an UNVERIFIED MPN cell names a concrete selected part', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'BOM.md'),
        `# Bill of Materials\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| R1 | 10k | R_0603 | UNVERIFIED: RC0603FR-0710KL | selected for 1% tolerance; confirm against datasheet |\n`,
        'utf8',
      );
      expect(await stageNamed('part-selection')(root, DOCS)).toBe(true);
    });
  });

  it('returns false when the text after UNVERIFIED is another placeholder', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'BOM.md'),
        `# Bill of Materials\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| R1 | 10k | R_0603 | UNVERIFIED: TBD | choose after review |\n`,
        'utf8',
      );
      expect(await stageNamed('part-selection')(root, DOCS)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Stage 5: layout-draft
// ---------------------------------------------------------------------------
describe('layout-draft isComplete', () => {
  it('instructs the agent to route all connections rather than complete with ratsnest', () => {
    const prompt = STAGES.find((stage) => stage.name === 'layout-draft')!.prompt('');
    expect(prompt).toContain('Route every electrical connection');
    expect(prompt).toContain('zero unconnected items');
    expect(prompt).not.toContain('leave the rest as ratsnest');
  });

  it('requires a real clean DRC result after the footprint and honesty marker exist', async () => {
    await withTmpDir(async (root) => {
      await writeBoardConfig(root);
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(path.join(root, DOCS, 'LAYOUT.md'), '# Layout\n\n## Draft quality\n\nPlacement is valid.\n', 'utf8');
      runDrcMock.mockResolvedValueOnce({
        ok: false,
        source: 'drc',
        violations: [{ type: 'unconnected_items', severity: 'error', description: 'R1.1 to R2.1' }],
      });

      expect(await stageNamed('layout-draft')(root, DOCS)).toBe(false);
      expect(runDrcMock).toHaveBeenCalledWith(path.join(root, 'hardware', 'board.kicad_pcb'));
    });
  });

  it('completes only when the populated, documented board is DRC-clean', async () => {
    await withTmpDir(async (root) => {
      await writeBoardConfig(root);
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(path.join(root, DOCS, 'LAYOUT.md'), '# Layout\n\n## Draft quality\n\nDRC-clean draft.\n', 'utf8');

      expect(await stageNamed('layout-draft')(root, DOCS)).toBe(true);
      expect(runDrcMock).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Stage 6: outputs
// ---------------------------------------------------------------------------
describe('outputs isComplete', () => {
  it('instructs the agent to verify the source board and require every output', () => {
    const prompt = STAGES.find((stage) => stage.name === 'outputs')!.prompt('');
    expect(prompt).toContain('run run_drc');
    expect(prompt).toContain('call export_outputs LAST');
    expect(prompt).toContain('partial or stale package is incomplete');
  });

  it('returns false when outputs/ does not exist', async () => {
    await withTmpDir(async (root) => {
      await writeBoardConfig(root);
      expect(await stageNamed('outputs')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when outputs/ exists but is empty (failed export run)', async () => {
    await withTmpDir(async (root) => {
      await writeBoardConfig(root);
      await mkdir(path.join(root, 'outputs'), { recursive: true });
      expect(await stageNamed('outputs')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when outputs/ contains only an ordering BOM', async () => {
    await withTmpDir(async (root) => {
      await writeBoardConfig(root);
      await mkdir(path.join(root, 'outputs'), { recursive: true });
      await writeFile(path.join(root, 'outputs', 'BOM.csv'), 'ref,mpn\nR1,RC0603\n', 'utf8');
      expect(await stageNamed('outputs')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when outputs/ contains only a .drl drill file (no Gerbers)', async () => {
    await withTmpDir(async (root) => {
      await writeBoardConfig(root);
      await mkdir(path.join(root, 'outputs'), { recursive: true });
      await writeFile(path.join(root, 'outputs', 'board.drl'), 'M48\n', 'utf8');
      expect(await stageNamed('outputs')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when only a Gerber exists', async () => {
    await withTmpDir(async (root) => {
      await writeBoardConfig(root);
      await mkdir(path.join(root, 'outputs'), { recursive: true });
      await writeFile(path.join(root, 'outputs', 'board-F_Cu.gbr'), 'G04 Gerber*\n', 'utf8');
      expect(await stageNamed('outputs')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when one required export is empty', async () => {
    await withTmpDir(async (root) => {
      await writeBoardConfig(root);
      await writeCompleteOutputs(root);
      await writeFile(path.join(root, 'outputs', 'board.step'), '', 'utf8');
      expect(await stageNamed('outputs')(root, DOCS)).toBe(false);
    });
  });

  it('requires a schematic render when a schematic is configured', async () => {
    await withTmpDir(async (root) => {
      await writeBoardConfig(root, 'hardware/design.kicad_sch');
      await writeCompleteOutputs(root, false, false);
      expect(await stageNamed('outputs')(root, DOCS)).toBe(false);
      await mkdir(path.join(root, 'outputs', 'renders'), { recursive: true });
      await writeFile(path.join(root, 'outputs', 'renders', 'design.svg'), '<svg/>\n', 'utf8');
      await writeExportReceipt({
        repoRoot: root,
        board: 'hardware/board.kicad_pcb',
        schematic: 'hardware/design.kicad_sch',
        bom: 'docs/BOM.md',
        artifacts: requiredFabArtifacts(true),
      });
      expect(await stageNamed('outputs')(root, DOCS)).toBe(true);
    });
  });

  it('requires the source board to remain DRC-clean', async () => {
    await withTmpDir(async (root) => {
      await writeBoardConfig(root);
      await writeCompleteOutputs(root);
      runDrcMock.mockResolvedValueOnce({
        ok: false,
        source: 'drc',
        violations: [{ type: 'clearance', severity: 'error', description: 'track clearance' }],
      });
      expect(await stageNamed('outputs')(root, DOCS)).toBe(false);
    });
  });

  it('returns true only for the complete non-empty export package on a clean board', async () => {
    await withTmpDir(async (root) => {
      await writeBoardConfig(root);
      await writeCompleteOutputs(root);
      expect(await stageNamed('outputs')(root, DOCS)).toBe(true);
      expect(runDrcMock).toHaveBeenCalledWith(path.join(root, 'hardware', 'board.kicad_pcb'));
    });
  });

  it('rejects a complete-looking package after the board source changes', async () => {
    await withTmpDir(async (root) => {
      await writeBoardConfig(root);
      await writeCompleteOutputs(root);
      await writeFile(path.join(root, 'hardware', 'board.kicad_pcb'), '(kicad_pcb\n  (footprint "Fixture:Changed")\n)\n', 'utf8');
      expect(await stageNamed('outputs')(root, DOCS)).toBe(false);
    });
  });

  it('rejects a complete-looking package when a recorded output changes', async () => {
    await withTmpDir(async (root) => {
      await writeBoardConfig(root);
      await writeCompleteOutputs(root);
      await writeFile(path.join(root, 'outputs', 'board.svg'), '<svg>changed</svg>\n', 'utf8');
      expect(await stageNamed('outputs')(root, DOCS)).toBe(false);
    });
  });

  it('rejects the package when a fabrication layer listed by KiCad becomes empty', async () => {
    await withTmpDir(async (root) => {
      await writeBoardConfig(root);
      await writeCompleteOutputs(root);
      await writeFile(path.join(root, 'outputs', 'gerbers', 'board-Edge_Cuts.gm1'), '', 'utf8');
      expect(await stageNamed('outputs')(root, DOCS)).toBe(false);
    });
  });

  it('rejects the ordering package after its BOM source changes', async () => {
    await withTmpDir(async (root) => {
      await writeBoardConfig(root);
      await writeCompleteOutputs(root);
      await writeFile(path.join(root, DOCS, 'BOM.md'), '# BOM\n\n| Refdes | MPN |\n|---|---|\n| R1 | DIFFERENT |\n', 'utf8');
      expect(await stageNamed('outputs')(root, DOCS)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Stage 7: firmware
// ---------------------------------------------------------------------------
describe('firmware isComplete', () => {
  it('returns false when firmware/ does not exist', async () => {
    await withTmpDir(async (root) => {
      expect(await stageNamed('firmware')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when firmware/ exists but is empty', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, 'firmware'), { recursive: true });
      expect(await stageNamed('firmware')(root, DOCS)).toBe(false);
    });
  });

  it('returns true when firmware/ contains a .h file (pins.h)', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, 'firmware'), { recursive: true });
      await writeFile(path.join(root, 'firmware', 'pins.h'), '#pragma once\n#define PIN_LED 2\n', 'utf8');
      expect(await stageNamed('firmware')(root, DOCS)).toBe(true);
    });
  });

  it('returns true when firmware/ contains a .py file (MicroPython)', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, 'firmware'), { recursive: true });
      await writeFile(path.join(root, 'firmware', 'main.py'), 'import machine\n', 'utf8');
      expect(await stageNamed('firmware')(root, DOCS)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Stage 8: devplan
// ---------------------------------------------------------------------------
describe('devplan isComplete', () => {
  it('returns false when DEVPLAN.md does not exist', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      expect(await stageNamed('devplan')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when DEVPLAN.md exists but is blank', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(path.join(root, DOCS, 'DEVPLAN.md'), '', 'utf8');
      expect(await stageNamed('devplan')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when DEVPLAN.md has only headings and no prose', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'DEVPLAN.md'),
        `# Development Plan\n\n## Bring-up steps\n\n## Test points\n`,
        'utf8',
      );
      expect(await stageNamed('devplan')(root, DOCS)).toBe(false);
    });
  });

  it('returns true when DEVPLAN.md has at least one section with content', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'DEVPLAN.md'),
        `# Development Plan\n\n## Bring-up steps\n\n1. Power on — measure 3.3 V rail.\n2. Flash firmware via USB-C.\n\n## Test points\n\nTP1: 3.3 V rail. TP2: GND.\n`,
        'utf8',
      );
      expect(await stageNamed('devplan')(root, DOCS)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Stage 4: schematic — legibility joins the contract (AC-16.22)
// ---------------------------------------------------------------------------
describe('schematic isComplete: legibility gate', () => {
  it('error-severity findings keep the stage active; a clean sheet completes', async () => {
    const { tempFixtureRepo } = await import('./helpers.js');
    const { runInit } = await import('../src/memory/scaffold.js');
    const { readFile, writeFile: wf } = await import('node:fs/promises');
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      // the fixture's caption must name a documented subsystem
      const subsPath = path.join(repo, 'docs', 'SUBSYSTEMS.md');
      await wf(subsPath, (await readFile(subsPath, 'utf8')) + '\n## Keyer\n\nKey input block.\n', 'utf8');
      const isComplete = stageNamed('schematic');
      expect(await isComplete(repo, DOCS)).toBe(true);

      // strip the group box: every symbol becomes ungrouped (error severity),
      // while symbols, drift, and ERC stay green — only legibility blocks now
      const schPath = path.join(repo, 'hardware', 'open-key.kicad_sch');
      const sch = await readFile(schPath, 'utf8');
      const stripped = sch.replace(/  \(rectangle \(start 80 84\)[\s\S]*?\n  \)\n/, '');
      expect(stripped).not.toBe(sch);
      await wf(schPath, stripped, 'utf8');
      expect(await isComplete(repo, DOCS)).toBe(false);
    } finally {
      await cleanup();
    }
  }, 60000);
});
