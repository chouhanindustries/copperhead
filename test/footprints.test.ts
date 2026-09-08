import { describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { populateBoardFromSchematic, searchInstalledFootprints } from '../src/kicad/footprints.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPEN_KEY = path.join(HERE, 'fixtures', 'open-key', 'hardware', 'open-key.kicad_sch');
const FOOTPRINTS = path.join(HERE, 'fixtures', 'footprints');
const EMPTY_BOARD = `(kicad_pcb
  (version 20240108)
  (generator "test")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "")
  (gr_rect (start 100 100) (end 130 120) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))
)
`;

async function repo(): Promise<{ root: string; board: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), 'copperhead-footprints-'));
  await cp(OPEN_KEY, path.join(root, 'board.kicad_sch'));
  const board = path.join(root, 'board.kicad_pcb');
  await writeFile(board, EMPTY_BOARD, 'utf8');
  return { root, board, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe('populateBoardFromSchematic', () => {
  it('copies real footprint bodies, assigns schematic nets, and is replay-deterministic', async () => {
    const a = await repo();
    const b = await repo();
    try {
      const placements = [
        { ref: 'R1', x: 105, y: 107, rotation: 90 },
        { ref: 'R2', x: 115, y: 107, rotation: 0 },
      ];
      await populateBoardFromSchematic({
        repoRoot: a.root,
        schematic: 'board.kicad_sch',
        board: 'board.kicad_pcb',
        placements,
        footprintDirs: [FOOTPRINTS],
      });
      await populateBoardFromSchematic({
        repoRoot: b.root,
        schematic: 'board.kicad_sch',
        board: 'board.kicad_pcb',
        placements,
        footprintDirs: [FOOTPRINTS],
      });
      const got = await readFile(a.board, 'utf8');
      expect(got).toBe(await readFile(b.board, 'utf8'));
      expect(got).toContain('(footprint "Resistor_SMD:R_0603_1608Metric"');
      expect(got).toContain('(fp_rect (start -1.4 -0.7)');
      expect(got).toContain('(property "Reference" "R1"');
      expect(got).toContain('(at 105 107 90)');
      // KiCad keeps child coordinates local but stores their orientation in
      // board coordinates, so every local angle follows the footprint turn.
      expect(got).toContain('(property "Reference" "R1" (at 0 -1.4 90)');
      expect(got).toContain('(pad "1" smd roundrect (at -0.825 0 90)');
      expect(got).toContain('(property "Reference" "R2" (at 0 -1.4 0)');
      expect(got).toContain('(pad "1" smd roundrect (at -0.825 0)');
      expect(got).toContain('(net 1 "3V3")');
      expect(got).toContain('(net 3 "GND")');
      expect(got).toContain('(net 2 "EN")');
      expect(got).toContain('(net 4 "KEY_DAH")');
      expect(new Set(got.match(/[0-9a-f]{8}-[0-9a-f-]{27}/g) ?? []).size).toBe(8);
      expect(got).toContain('(gr_rect (start 100 100) (end 130 120)');
      expect(got.indexOf('(net 1 "3V3")')).toBeLessThan(got.indexOf('(gr_rect'));
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('validates every requested source before writing the board', async () => {
    const t = await repo();
    try {
      const before = await readFile(t.board, 'utf8');
      await expect(
        populateBoardFromSchematic({
          repoRoot: t.root,
          schematic: 'board.kicad_sch',
          board: 'board.kicad_pcb',
          placements: [
            { ref: 'R1', x: 105, y: 107 },
            { ref: 'U1', x: 115, y: 107 },
          ],
          footprintDirs: [FOOTPRINTS],
        }),
      ).rejects.toThrow(/U1: installed footprint RF_Module:ESP32-S3-MINI-1 was not found/);
      expect(await readFile(t.board, 'utf8')).toBe(before);
    } finally {
      await t.cleanup();
    }
  });

  it('refuses duplicate placement refs and an existing board ref', async () => {
    const t = await repo();
    try {
      const base = {
        repoRoot: t.root,
        schematic: 'board.kicad_sch',
        board: 'board.kicad_pcb',
        footprintDirs: [FOOTPRINTS],
      };
      await expect(
        populateBoardFromSchematic({ ...base, placements: [{ ref: 'R1', x: 1, y: 2 }, { ref: 'R1', x: 3, y: 4 }] }),
      ).rejects.toThrow(/duplicate footprint placement ref R1/);
      await populateBoardFromSchematic({ ...base, placements: [{ ref: 'R1', x: 1, y: 2 }] });
      const once = await readFile(t.board, 'utf8');
      await expect(populateBoardFromSchematic({ ...base, placements: [{ ref: 'R1', x: 3, y: 4 }] })).rejects.toThrow(
        /board already contains footprint R1/,
      );
      expect(await readFile(t.board, 'utf8')).toBe(once);
    } finally {
      await t.cleanup();
    }
  });
});

describe('searchInstalledFootprints', () => {
  it('returns installed lib_ids for exact and multi-token queries', async () => {
    expect(await searchInstalledFootprints('R_0603_1608Metric', [FOOTPRINTS])).toEqual([
      'Resistor_SMD:R_0603_1608Metric',
    ]);
    expect(await searchInstalledFootprints('1x02 P3.50', [FOOTPRINTS])).toEqual([
      'TerminalBlock_4Ucon:TerminalBlock_4Ucon_1x02_P3.50mm_Vertical',
    ]);
  });

  it('finds semantic descr/tags with separator and camel-case normalization, but never footprint body text', async () => {
    expect(await searchInstalledFootprints('USB_C_Receptacle_PowerOnly', [FOOTPRINTS])).toEqual([
      'Connector_USB:USB4125',
      'Connector_USB:USB4135',
    ]);
    expect(await searchInstalledFootprints('USB4125 PowerOnly', [FOOTPRINTS])).toEqual(['Connector_USB:USB4125']);
    expect(await searchInstalledFootprints('BodyOnlyPowerMarker', [FOOTPRINTS])).toEqual([]);
  });

  it('returns no result for a missing footprint or path-like query', async () => {
    expect(await searchInstalledFootprints('691137710002', [FOOTPRINTS])).toEqual([]);
    expect(await searchInstalledFootprints('../../Resistor_SMD.pretty', [FOOTPRINTS])).toEqual([]);
  });

  it('caps results at fifty even when a larger cap is requested', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'copperhead-footprint-search-'));
    const library = path.join(root, 'Many.pretty');
    try {
      await mkdir(library);
      await Promise.all(
        Array.from({ length: 55 }, (_, i) => writeFile(path.join(library, `Match_${i}.kicad_mod`), '(footprint "x")')),
      );
      expect(await searchInstalledFootprints('Match', [root], 100)).toHaveLength(50);
      expect(await searchInstalledFootprints('Match', [root], 7)).toHaveLength(7);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
