import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveLibrarySymbol, verifySchematicSymbols } from '../src/kicad/symlib.js';

// A minimal stand-in for /usr/share/kicad/symbols/Device.kicad_sym: R (2 pins)
// and R_Small which `extends` R (inherits R's pins, has none of its own).
const DEVICE_LIB = `(kicad_symbol_lib (version 20251024) (generator test)
  (symbol "R" (pin_numbers hide) (pin_names (offset 0))
    (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54)))
    (symbol "R_1_1"
      (pin passive line (at 0 3.81 270) (length 1.27) (name "~") (number "1"))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2"))
    )
  )
  (symbol "R_Small" (extends "R"))
)`;

// A schematic whose lib_symbols mixes a faithful copy, a wrong-pin-count copy, a
// nonexistent lib_id, and one whose library is not installed here.
function schematic(): string {
  return `(kicad_sch (version 20251024) (generator test)
  (lib_symbols
    (symbol "Device:R" (pin_numbers hide) (pin_names (offset 0))
      (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54)))
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27) (name "~") (number "1"))
        (pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2"))
      )
    )
    (symbol "Device:R_Small"
      (symbol "R_Small_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27) (name "~") (number "1"))
        (pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2"))
        (pin passive line (at 0 0 90) (length 1.27) (name "~") (number "3"))
      )
    )
    (symbol "Nowhere:Gadget"
      (symbol "Gadget_1_1"
        (pin passive line (at 0 0 0) (length 1.27) (name "A") (number "1"))
      )
    )
  )
)`;
}

describe('symlib (I9: verify symbols against the installed KiCad library)', () => {
  let libDir: string;
  let schPath: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    libDir = await mkdtemp(path.join(tmpdir(), 'copperhead-symlib-test-'));
    await writeFile(path.join(libDir, 'Device.kicad_sym'), DEVICE_LIB, 'utf8');
    const work = await mkdtemp(path.join(tmpdir(), 'copperhead-sch-test-'));
    schPath = path.join(work, 'x.kicad_sch');
    await writeFile(schPath, schematic(), 'utf8');
    // Point discovery at our fake lib only; nothing else on PATH matters.
    env = { KICAD_SYMBOL_DIR: libDir };
  });

  afterAll(async () => {
    await rm(libDir, { recursive: true, force: true }).catch(() => {});
    await rm(path.dirname(schPath), { recursive: true, force: true }).catch(() => {});
  });

  it('resolves an exact symbol to its real pins', async () => {
    const r = await resolveLibrarySymbol('Device:R', [libDir]);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.pins.map((p) => p.number).sort()).toEqual(['1', '2']);
      expect(r.pins.every((p) => p.type === 'passive')).toBe(true);
    }
  });

  it('follows `extends` to the base symbol for pins', async () => {
    const r = await resolveLibrarySymbol('Device:R_Small', [libDir]);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.pins).toHaveLength(2);
  });

  it('reports candidates when the exact name is absent', async () => {
    const r = await resolveLibrarySymbol('Device:R_Nonexistent', [libDir]);
    expect(r.status).toBe('no-symbol');
    if (r.status === 'no-symbol') expect(r.candidates).toContain('R'); // substring match
  });

  it('reports no-library when the library file is missing', async () => {
    const r = await resolveLibrarySymbol('Connector:Whatever', [libDir]);
    expect(r.status).toBe('no-library');
  });

  it('verifies a schematic: clean match, pin-count diff, missing symbol, uninstalled lib', async () => {
    const { findings, checked, skipped } = await verifySchematicSymbols(schPath, env);
    // Device:R matched cleanly → counts as checked, no finding.
    const kinds = findings.map((f) => f.kind);
    expect(checked).toBeGreaterThanOrEqual(1);
    // Device:R_Small (extends R → 2 pins) authored with 3 pins.
    expect(kinds).toContain('pin-count');
    // Nowhere:Gadget → Nowhere.kicad_sym not installed → skipped, not a mismatch.
    expect(kinds).toContain('no-library');
    expect(skipped).toBe(1);
    // The faithful Device:R must NOT produce a pin-mismatch.
    expect(findings.find((f) => f.libId === 'Device:R')).toBeUndefined();
  });
});
