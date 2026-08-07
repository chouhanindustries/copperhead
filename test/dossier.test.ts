import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveLibrarySymbol } from '../src/kicad/symlib.js';
import { bomSymbolDossier } from '../src/kicad/dossier.js';
import { dispatchTool, type RunContext } from '../src/agent/tools.js';
import { ObligationsLedger } from '../src/agent/ledger.js';

// Fixture stand-ins for the installed libraries: a passive with a derived
// symbol, a single-unit and a multi-unit gate (the SN74LVC2G17 trap from the
// lemondrop run), and a codec resolvable by MPN.
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

const LOGIC_LIB = `(kicad_symbol_lib (version 20251024) (generator test)
  (symbol "SN74LVC1G17" (pin_names (offset 1.016))
    (symbol "SN74LVC1G17_1_1"
      (pin input line (at -7.62 0 0) (length 2.54) (name "A") (number "2"))
      (pin output line (at 7.62 0 180) (length 2.54) (name "Y") (number "4"))
      (pin power_in line (at 0 7.62 270) (length 2.54) (name "VCC") (number "5"))
      (pin power_in line (at 0 -7.62 90) (length 2.54) (name "GND") (number "3"))
    )
  )
  (symbol "SN74LVC2G17" (pin_names (offset 1.016))
    (symbol "SN74LVC2G17_1_1"
      (pin input line (at -7.62 0 0) (length 2.54) (name "1A") (number "1"))
      (pin output line (at 7.62 0 180) (length 2.54) (name "1Y") (number "6"))
    )
    (symbol "SN74LVC2G17_2_1"
      (pin input line (at -7.62 0 0) (length 2.54) (name "2A") (number "3"))
      (pin output line (at 7.62 0 180) (length 2.54) (name "2Y") (number "4"))
    )
  )
)`;

const AUDIO_LIB = `(kicad_symbol_lib (version 20251024) (generator test)
  (symbol "TLV320AIC3100" (pin_names (offset 1.016))
    (symbol "TLV320AIC3100_1_1"
      (pin power_in line (at 0 7.62 270) (length 2.54) (name "AVDD") (number "1"))
      (pin bidirectional line (at -7.62 0 0) (length 2.54) (name "SDA") (number "2"))
      (pin input line (at -7.62 -2.54 0) (length 2.54) (name "SCL") (number "3"))
    )
  )
)`;

const BOM = `| Refdes | Value | Footprint | MPN | Rationale |
| --- | --- | --- | --- | --- |
| U1 | codec | Package_DFN_QFN:X | TLV320AIC3100 | audio codec |
| U2 | buffer | Package_TO_SOT_SMD:X | SN74LVC2G17 | dual schmitt buffer |
| U3 | ghost | Package_QFP:X | XYZQ9999ZZ | not installed anywhere |
| SW2 | R_Small | Button:X | | value fallback row |
| R1 | 10k | Resistor_SMD:X | UNVERIFIED | passive, omitted |
| C3 | 100n | Capacitor_SMD:X | UNVERIFIED | passive, omitted |
`;

describe('pin dossier (R14: stage-4 entry pin facts)', () => {
  let libDir: string;

  beforeAll(async () => {
    libDir = await mkdtemp(path.join(tmpdir(), 'copperhead-dossier-test-'));
    await writeFile(path.join(libDir, 'Device.kicad_sym'), DEVICE_LIB, 'utf8');
    await writeFile(path.join(libDir, 'Logic.kicad_sym'), LOGIC_LIB, 'utf8');
    await writeFile(path.join(libDir, 'Audio.kicad_sym'), AUDIO_LIB, 'utf8');
  });

  afterAll(async () => {
    await rm(libDir, { recursive: true, force: true });
  });

  describe('resolveLibrarySymbol unit count', () => {
    it('single-unit symbol reports 1', async () => {
      const r = await resolveLibrarySymbol('Device:R', [libDir]);
      expect(r.status).toBe('ok');
      if (r.status === 'ok') expect(r.units).toBe(1);
    });

    it('multi-unit symbol reports its unit count', async () => {
      const r = await resolveLibrarySymbol('Logic:SN74LVC2G17', [libDir]);
      expect(r.status).toBe('ok');
      if (r.status === 'ok') expect(r.units).toBe(2);
    });

    it('derived symbol reports the base unit count with the base pins', async () => {
      const r = await resolveLibrarySymbol('Device:R_Small', [libDir]);
      expect(r.status).toBe('ok');
      if (r.status === 'ok') {
        expect(r.pins).toHaveLength(2);
        expect(r.units).toBe(1);
      }
    });
  });

  describe('bomSymbolDossier', () => {
    it('resolves MPN rows to lib_id and full pin table', async () => {
      const d = await bomSymbolDossier(BOM, [libDir]);
      expect(d).toContain('U1 (TLV320AIC3100): Audio:TLV320AIC3100 — 3 pin(s)');
      expect(d).toContain('1=AVDD/power_in');
      expect(d).toContain('2=SDA/bidirectional');
    });

    it('flags multi-unit symbols as ones the engine refuses', async () => {
      const d = await bomSymbolDossier(BOM, [libDir]);
      expect(d).toContain('MULTI-UNIT (2 units)');
      expect(d).toMatch(/U2 \(SN74LVC2G17\).*refuses/);
    });

    it('falls back to the Value column when the MPN is empty', async () => {
      const d = await bomSymbolDossier(BOM, [libDir]);
      expect(d).toContain('SW2 (R_Small): Device:R_Small — 2 pin(s)');
    });

    it('names parts nothing matches instead of omitting them', async () => {
      const d = await bomSymbolDossier(BOM, [libDir]);
      expect(d).toMatch(/U3 \(XYZQ9999ZZ\): NO INSTALLED SYMBOL/);
    });

    it('omits pure-passive refdes classes', async () => {
      const d = await bomSymbolDossier(BOM, [libDir]);
      expect(d).not.toMatch(/^- R1[ ,(]/m);
      expect(d).not.toMatch(/^- C3[ ,(]/m);
      expect(d).not.toContain('(10k)');
      expect(d).not.toContain('(100n)');
    });

    it('discloses size-cap overflow by name, never silently', async () => {
      const d = await bomSymbolDossier(BOM, [libDir], { maxChars: 120 });
      expect(d).toContain('NOT INCLUDED (size cap 120 chars)');
      expect(d).toContain('symbol_pins');
      // every non-passive part appears exactly once: rendered or disclosed
      for (const who of ['U1', 'U2', 'U3', 'SW2']) expect(d).toContain(who);
    });

    it('degrades to empty on no dirs, no rows, and garbage input', async () => {
      expect(await bomSymbolDossier(BOM, [])).toBe('');
      expect(await bomSymbolDossier('no table here', [libDir])).toBe('');
      expect(await bomSymbolDossier(BOM, [path.join(libDir, 'nonexistent')])).toBe('');
    });
  });

  describe('symbol_pins tool', () => {
    let savedEnv: string | undefined;
    const ctx = (): RunContext =>
      ({
        repoRoot: '/nonexistent',
        config: {},
        transcript: { event: async () => {} },
        ledger: new ObligationsLedger(),
        runId: 'test',
        interactive: false,
        confirm: async () => true,
        editsUnlocked: false,
        changeId: null,
        proposalValidated: false,
        filesTouched: new Set(),
        decisions: [],
        lastErc: null,
        lastDrc: null,
        lastLegibility: null,
        lastScore: null,
        repairCycles: 0,
        finishRequest: null,
      }) as never;

    beforeAll(() => {
      savedEnv = process.env.KICAD_SYMBOL_DIR;
      process.env.KICAD_SYMBOL_DIR = libDir;
    });

    afterAll(() => {
      if (savedEnv === undefined) delete process.env.KICAD_SYMBOL_DIR;
      else process.env.KICAD_SYMBOL_DIR = savedEnv;
    });

    it('reports pins and unit count for a resolved lib_id', async () => {
      const out = await dispatchTool(ctx(), 'symbol_pins', { lib_id: 'Logic:SN74LVC1G17' });
      expect(out).toContain('4 pin(s), 1 unit(s)');
      expect(out).toContain('2: A · input');
      expect(out).toContain('5: VCC · power_in');
      expect(out).not.toContain('WARNING');
    });

    it('warns on a multi-unit symbol', async () => {
      const out = await dispatchTool(ctx(), 'symbol_pins', { lib_id: 'Logic:SN74LVC2G17' });
      expect(out).toContain('2 unit(s)');
      expect(out).toContain('refuses multi-unit symbols');
    });

    it('redirects a wrong-library guess to where the symbol lives', async () => {
      const out = await dispatchTool(ctx(), 'symbol_pins', { lib_id: 'Device:SN74LVC1G17' });
      expect(out).toContain('does not exist in that library');
      expect(out).toContain('installed as: Logic:SN74LVC1G17');
    });

    it('handles an uninstalled library nickname', async () => {
      const out = await dispatchTool(ctx(), 'symbol_pins', { lib_id: 'Nowhere:TLV320AIC3100' });
      expect(out).toContain('no library named "Nowhere" is installed');
      expect(out).toContain('installed as: Audio:TLV320AIC3100');
    });
  });
});
