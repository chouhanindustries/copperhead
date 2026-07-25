import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { listSymbols, listNets, pinNets, parseSexp } from '../src/kicad/sexp.js';
import { FIXTURE } from './helpers.js';

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
});
import { describe, it, expect } from 'vitest';
import { addPowerSymbolPrefixes } from '../src/kicad/sexp.js';
import { listSymbols } from '../src/kicad/sexp.js';
import path from 'node:path';
import { tempFixtureRepo } from './helpers.js';
import { mkdir, writeFile } from 'node:fs/promises';

describe('isPowerSymbol with custom prefixes', () => {
  it('default behavior: power: prefix is recognized', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const sch = path.join(repo, 'hardware', 'test.kicad_sch');
      await mkdir(path.dirname(sch), { recursive: true });
      // A minimal sch with only a power symbol (which should be excluded)
      await writeFile(sch, `(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (lib_symbols
    (symbol "power:VCC"
      (pin_numbers (pin_count 1) (number_size 50))
      (pin_names (offset 0) (hide))
      (in_bom yes) (on_board yes)
      (symbol "VCC_0_1"
        (pin power_in line (at 0 0 90) (length 0)
          (name "VCC" (effects (font (size 50 50))))
          (number "1" (effects (font (size 50 50))))
        )
      )
    )
  )
  (symbol (lib_id "power:VCC") (at 0 0 0)
    (property "Reference" "#PWR1" (at 0 0 0)(effects (font (size 50 50)) (justify left)))
    (property "Value" "VCC" (at 0 0 0)(effects (font (size 50 50)) (justify left)))
    (pin "1" (uuid "0000-0001"))
    (instances (project "test" (path "/" (page "1"))))
  )
  (sheet_instances (path "/" (page "1")))
)`, 'utf8');
      // power:VCC should be excluded from listSymbols
      const syms = await listSymbols(sch);
      expect(syms).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it('custom prefixes are recognized after addPowerSymbolPrefixes', async () => {
    // Register a custom prefix
    addPowerSymbolPrefixes(['custom_power:']);
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const sch = path.join(repo, 'hardware', 'test.kicad_sch');
      await mkdir(path.dirname(sch), { recursive: true });
      await writeFile(sch, `(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (lib_symbols
    (symbol "custom_power:MY_VCC"
      (pin_numbers (pin_count 1) (number_size 50))
      (pin_names (offset 0) (hide))
      (in_bom yes) (on_board yes)
      (symbol "MY_VCC_0_1"
        (pin power_in line (at 0 0 90) (length 0)
          (name "MY_VCC" (effects (font (size 50 50))))
          (number "1" (effects (font (size 50 50))))
        )
      )
    )
  )
  (symbol (lib_id "custom_power:MY_VCC") (at 0 0 0)
    (property "Reference" "#PWR1" (at 0 0 0)(effects (font (size 50 50)) (justify left)))
    (property "Value" "MY_VCC" (at 0 0 0)(effects (font (size 50 50)) (justify left)))
    (pin "1" (uuid "0000-0001"))
    (instances (project "test" (path "/" (page "1"))))
  )
  (sheet_instances (path "/" (page "1")))
)`, 'utf8');
      const syms = await listSymbols(sch);
      expect(syms).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it('throws an error if empty or blank prefixes are provided', () => {
    expect(() => addPowerSymbolPrefixes([''])).toThrow('Power symbol prefixes must be non-empty');
    expect(() => addPowerSymbolPrefixes(['   '])).toThrow('Power symbol prefixes must be non-empty');
  });
});
