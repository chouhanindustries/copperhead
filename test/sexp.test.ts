import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { listSymbols, listNets, pinNets, parseSexp } from '../src/kicad/sexp.js';
import { FIXTURE, tempFixtureRepo } from './helpers.js';

const SCH = path.join(FIXTURE, 'hardware', 'open-key.kicad_sch');

describe('sexp parser', () => {
  it('parses quoted strings with escapes', () => {
    const [node] = parseSexp('(a "b \\"c\\"" d)');
    expect(node).toEqual(['a', 'b "c"', 'd']);
  });

  it('lists real symbols with refdes, value, footprint (AC-1.2 source)', async () => {
    const syms = await listSymbols(SCH);
    expect(syms.map((s) => s.ref)).toEqual(['R1', 'R2', 'U1']);
    const r1 = syms.find((s) => s.ref === 'R1')!;
    expect(r1.value).toBe('10k');
    expect(r1.footprint).toBe('Resistor_SMD:R_0603_1608Metric');
    const u1 = syms.find((s) => s.ref === 'U1')!;
    expect(u1.value).toBe('ESP32-S3-MINI');
  });

  it('lists nets from labels', async () => {
    const nets = await listNets(SCH);
    expect(nets).toEqual(['3V3', 'EN', 'GND', 'KEY_DAH']);
  });

  it('maps pins to nets geometrically (AC-1.3 source)', async () => {
    const pins = await pinNets(SCH);
    const u1 = new Map(pins.filter((p) => p.ref === 'U1').map((p) => [p.pinName, p.net]));
    expect(u1.get('GPIO14')).toBe('KEY_DAH');
    expect(u1.get('3V3')).toBe('3V3');
    expect(u1.get('GND')).toBe('GND');
    expect(u1.get('EN')).toBe('EN');
    expect(u1.get('GPIO0')).toBeNull();
    const r2 = new Map(pins.filter((p) => p.ref === 'R2').map((p) => [p.pinNumber, p.net]));
    expect(r2.get('1')).toBe('KEY_DAH');
    expect(r2.get('2')).toBe('GND');
  });

  it('connects a mid-segment label and does not rename its net to PWR_FLAG', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const sch = path.join(repo, 'hardware', 'open-key.kicad_sch');
      let text = await readFile(sch, 'utf8');
      text = text
        .replace(
          '    (symbol "fixture:ESP32-S3-MINI"',
          `    (symbol "power:PWR_FLAG"
      (property "Reference" "#FLG" (at 0 1.27 0)
        (effects (font (size 1.27 1.27)) hide)
      )
      (property "Value" "PWR_FLAG" (at 0 -1.27 0)
        (effects (font (size 1.27 1.27)))
      )
      (symbol "PWR_FLAG_1_1"
        (pin power_in line (at 0 0 0) (length 0)
          (name "pwr" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27))))
        )
      )
    )
    (symbol "fixture:ESP32-S3-MINI"`,
        )
        .replace(
          '  (global_label "3V3" (shape input) (at 127 91.44 180)',
          `  (wire
    (pts (xy 127 91.44) (xy 132.08 91.44))
    (stroke (width 0) (type default))
    (uuid "f0000000-0000-4000-8000-000000000001")
  )
  (global_label "3V3" (shape input) (at 129.54 91.44 180)`,
        )
        .replace(
          '  (sheet_instances',
          `  (symbol
    (lib_id "power:PWR_FLAG")
    (at 132.08 91.44 0)
    (unit 1)
    (exclude_from_sim no)
    (in_bom no)
    (on_board no)
    (dnp no)
    (uuid "f0000000-0000-4000-8000-000000000002")
    (property "Reference" "#FLG01" (at 132.08 90.17 0)
      (effects (font (size 1.27 1.27)) hide)
    )
    (property "Value" "PWR_FLAG" (at 132.08 89.535 0)
      (effects (font (size 1.27 1.27)))
    )
    (pin "1" (uuid "f0000000-0000-4000-8000-000000000003"))
  )
  (sheet_instances`,
        );
      await writeFile(sch, text, 'utf8');

      const pins = await pinNets(sch);
      expect(pins.find((pin) => pin.ref === 'U1' && pin.pinName === '3V3')?.net).toBe('3V3');
      expect(await listNets(sch)).not.toContain('PWR_FLAG');
    } finally {
      await cleanup();
    }
  });
});
