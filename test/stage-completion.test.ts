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
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { STAGES } from '../src/commands/create.js';

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
      await mkdir(path.join(root, '.copperhead'), { recursive: true });
      await writeFile(
        path.join(root, '.copperhead', 'constraints.json'),
        JSON.stringify(
          {
            'power.sleep_current_uA': {
              max: 25,
              source: 'docs/SPEC.md',
              affects: [],
            },
            'power.peak_current_mA': {
              max: 500,
              source: 'docs/SPEC.md',
              affects: [],
            },
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );
      expect(await stageNamed('spec-seed')(root, DOCS)).toBe(true);
    });
  });

  it('returns false when a registry key is only a substring of a documented budget', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });

      await writeFile(
        path.join(root, DOCS, 'SPEC.md'),
        `# My Project

## Budgets

- sleep_current_uA: 25

## Assumptions
`,
        'utf8',
      );

      await mkdir(path.join(root, '.copperhead'), { recursive: true });
      await writeFile(
        path.join(root, '.copperhead', 'constraints.json'),
        JSON.stringify(
          {
            'power.current_uA': {
              max: 25,
              source: 'docs/SPEC.md',
              affects: [],
            },
          },
          null,
          2,
        ) + '\n',
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

  it('returns true when at least one BOM row has a real (non-UNVERIFIED) MPN', async () => {
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
});

// ---------------------------------------------------------------------------
// Stage 6: outputs
// ---------------------------------------------------------------------------
describe('outputs isComplete', () => {
  it('returns false when outputs/ does not exist', async () => {
    await withTmpDir(async (root) => {
      expect(await stageNamed('outputs')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when outputs/ exists but is empty (failed export run)', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, 'outputs'), { recursive: true });
      expect(await stageNamed('outputs')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when outputs/ contains only non-Gerber files', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, 'outputs'), { recursive: true });
      await writeFile(path.join(root, 'outputs', 'BOM.csv'), 'ref,mpn\nR1,RC0603\n', 'utf8');
      expect(await stageNamed('outputs')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when outputs/ contains only a .drl drill file (no Gerbers)', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, 'outputs'), { recursive: true });
      await writeFile(path.join(root, 'outputs', 'board.drl'), 'M48\n', 'utf8');
      expect(await stageNamed('outputs')(root, DOCS)).toBe(false);
    });
  });

  it('returns true when outputs/ contains at least one Gerber file (.gbr)', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, 'outputs'), { recursive: true });
      await writeFile(path.join(root, 'outputs', 'board-F_Cu.gbr'), 'G04 Gerber*\n', 'utf8');
      expect(await stageNamed('outputs')(root, DOCS)).toBe(true);
    });
  });

  it('returns true when outputs/ contains a .gtl (top copper) Gerber', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, 'outputs'), { recursive: true });
      await writeFile(path.join(root, 'outputs', 'board.gtl'), 'G04*\n', 'utf8');
      expect(await stageNamed('outputs')(root, DOCS)).toBe(true);
    });
  });

  it('returns true when Gerber file is located in a nested subdirectory inside outputs/', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, 'outputs', 'gerbers'), { recursive: true });
      await writeFile(path.join(root, 'outputs', 'gerbers', 'board-F_Cu.gbr'), 'G04 Gerber*\n', 'utf8');
      expect(await stageNamed('outputs')(root, DOCS)).toBe(true);
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
