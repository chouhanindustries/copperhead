import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveLibrarySymbol,
  verifySchematicSymbols,
  closestSymbolNames,
  searchInstalledSymbols,
} from '../src/kicad/symlib.js';
import { symbolAvailabilityFacts } from '../src/agent/recovery.js';

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
    const r = await resolveLibrarySymbol('Device:R_Smal', [libDir]);
    expect(r.status).toBe('no-symbol');
    if (r.status === 'no-symbol') expect(r.candidates).toContain('R_Small'); // prefix match
  });

  it('never pads candidates with single-letter generics for a long query (#195)', async () => {
    // Old behavior: "R" ⊂ "R_Nonexistent" counted as a match, so any long
    // query got the library's one-letter passives as "closest" suggestions.
    const r = await resolveLibrarySymbol('Device:R_Nonexistent', [libDir]);
    expect(r.status).toBe('no-symbol');
    if (r.status === 'no-symbol') expect(r.candidates).not.toContain('R');
  });

  it('reports no-library when the library file is missing', async () => {
    const r = await resolveLibrarySymbol('Connector:Whatever', [libDir]);
    expect(r.status).toBe('no-library');
  });

  it('ranks separator-variant names as near-misses and drops sub-units (#195)', () => {
    // Real strings from the lemondrop run (run-logs/2026-08-07T17-52-03): the
    // validator answered "Device:Rotary_Encoder" with "closest: C, D, R" while
    // RotaryEncoder_Switch sat one underscore away in that library.
    const device = ['C', 'D', 'L', 'R', 'FerriteBead', 'RotaryEncoder', 'RotaryEncoder_Switch', 'RotaryEncoder_Switch_MP'];
    const got = closestSymbolNames(device, 'Rotary_Encoder');
    expect(got[0]).toBe('RotaryEncoder'); // separator-insensitive exact match first
    expect(got).toContain('RotaryEncoder_Switch');
    expect(got).not.toContain('C');
    expect(got).not.toContain('R');

    // "microSD_Card" differs from the installed name by case and underscore placement.
    expect(closestSymbolNames(['Micro_SD_Card', 'Micro_SD_Card_Det1', 'USB_A'], 'microSD_Card')[0]).toBe('Micro_SD_Card');

    // Sub-unit children polluted 5 of 8 candidate slots in the real run.
    const audio = ['TLV320AIC23BPW', 'TLV320AIC23BPW_0_1', 'TLV320AIC23BPW_1_1', 'TLV320AIC23BRHD', 'TLV320AIC23BRHD_0_1', 'TLV320AIC23BRHD_1_1', 'TLV320AIC3100', 'TLV320AIC3100_0_1'];
    const tlv = closestSymbolNames(audio, 'TLV320');
    expect(tlv.sort()).toEqual(['TLV320AIC23BPW', 'TLV320AIC23BRHD', 'TLV320AIC3100']);
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

// A one-pin top-level symbol entry, with the sub-unit child the scrape must skip.
const sym = (name: string): string =>
  `  (symbol "${name}" (pin_names (offset 0))
    (symbol "${name}_1_1"
      (pin passive line (at 0 0 0) (length 1.27) (name "~") (number "1"))
    )
  )`;
const lib = (...names: string[]): string =>
  `(kicad_symbol_lib (version 20251024) (generator test)\n${names.map(sym).join('\n')}\n)`;

describe('cross-library discovery and refusal fact-checking (#195, #196, #197)', () => {
  // The lemondrop run's real layout: the parts the stage-4 agent declared
  // "verified absent" live in libraries it never guessed.
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'copperhead-symsearch-test-'));
    await writeFile(path.join(dir, 'Audio.kicad_sym'), lib('TLV320AIC23BPW', 'TLV320AIC3100'), 'utf8');
    await writeFile(path.join(dir, 'Driver_LED.kicad_sym'), lib('TPS61165DBV'), 'utf8');
    await writeFile(path.join(dir, 'Connector_Audio.kicad_sym'), lib('AudioJack3', 'AudioJack3_Ground'), 'utf8');
    await writeFile(path.join(dir, 'Device.kicad_sym'), lib('C', 'D', 'R', 'RotaryEncoder_Switch'), 'utf8');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('finds a part filed under a library nickname the caller could not derive', async () => {
    expect(await searchInstalledSymbols('TPS61165', [dir])).toEqual(['Driver_LED:TPS61165DBV']);
    expect(await searchInstalledSymbols('AudioJack3', [dir])).toContain('Connector_Audio:AudioJack3');
    // exact (separator-insensitive) matches outrank other libraries' near-misses
    expect((await searchInstalledSymbols('Rotary_Encoder_Switch', [dir]))[0]).toBe('Device:RotaryEncoder_Switch');
  });

  it('returns nothing for a part that is genuinely absent everywhere', async () => {
    expect(await searchInstalledSymbols('TLP2361', [dir])).toEqual([]);
  });

  it('fact-checks lib_ids named in a refusal against the installed libraries', async () => {
    // Condensed from the recorded constraint that drove the real abort: the
    // first claim is false (the symbol resolves), the second names a part
    // that is installed under a different library.
    const refusal =
      'VERIFIED ABSENT: "Audio:TLV320AIC23BPW" does not exist; ' +
      'Regulator_Switching:TPS61165 is not installed (see docs/BOM.md and create.ts:311)';
    const facts = await symbolAvailabilityFacts(refusal, [dir]);
    expect(facts).toMatch(/Audio:TLV320AIC23BPW: RESOLVES/);
    expect(facts).toContain('Driver_LED:TPS61165DBV');
    // file:line refs are not lib_ids
    expect(facts).not.toContain('create.ts');
  });

  it('produces no facts block when the text names no lib_ids', async () => {
    expect(await symbolAvailabilityFacts('turn timed out after 300s; see create.ts:311', [dir])).toBe('');
  });
});
