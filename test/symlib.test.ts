import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveLibrarySymbol,
  verifySchematicSymbols,
  symbolSearchDirs,
  findSymbolAcrossLibraries,
  crossLibraryIds,
} from '../src/kicad/symlib.js';
import { SymbolSource } from '../src/kicad/draft/symsource.js';

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

describe('cross-library resolution (review findings on #186)', () => {
  let libDir: string;

  beforeAll(async () => {
    libDir = await mkdtemp(path.join(tmpdir(), 'copperhead-crosslib-test-'));
    // Device.kicad_sym: guessed-but-wrong library for these tests, plus a
    // same-file typo target (R_Small) that must still win over any
    // cross-library fuzzy noise.
    await writeFile(path.join(libDir, 'Device.kicad_sym'), DEVICE_LIB, 'utf8');
    // The real symbol lives elsewhere, and is spelled differently than the
    // query (SHT4x, not SHT40) — the shape that broke substring-only matching.
    await writeFile(
      path.join(libDir, 'Sensor_Humidity.kicad_sym'),
      `(kicad_symbol_lib (version 20251024) (generator test)
  (symbol "SHT4x" (pin_numbers hide) (pin_names (offset 0))
    (symbol "SHT4x_1_1"
      (pin passive line (at 0 3.81 270) (length 1.27) (name "~") (number "1"))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2"))
    )
  )
)`,
      'utf8',
    );
  });

  afterAll(async () => {
    await rm(libDir, { recursive: true, force: true });
  });

  it('finds an exact match under a different library name', async () => {
    const matches = await findSymbolAcrossLibraries('SHT4x', [libDir], 'Sensor_Wrong');
    expect(matches).toContainEqual({ lib: 'Sensor_Humidity', name: 'SHT4x', exact: true });
  });

  it('a fuzzy cross-library match reports the real symbol name, not the query', async () => {
    const matches = await findSymbolAcrossLibraries('SHT40', [libDir], 'Sensor_Wrong');
    const hit = matches.find((m) => m.lib === 'Sensor_Humidity');
    expect(hit).toBeDefined();
    expect(hit!.exact).toBe(false);
    // The bug this guards: recording only `{ lib, exact }` and reconstructing
    // the suggestion from the caller's original query built "Sensor_Humidity:SHT40",
    // a lib_id that does not exist anywhere.
    expect(hit!.name).toBe('SHT4x');
  });

  it('does not match a genuinely different part number one edit away', async () => {
    // TPS22860 vs TPS22810: same length, one character differs. Real parts,
    // not the same chip. The 1-edit cap must not blur them together.
    const matches = await findSymbolAcrossLibraries('TPS22860', [libDir], 'Power_Switch');
    expect(matches.some((m) => m.name === 'TPS22810')).toBe(false);
  });

  it('a same-file typo wins over a cross-library fuzzy match, and never suggests itself', async () => {
    // Device:R_Sma is a typo of Device:R_Small, which lives in the same file.
    // The fix on #186 ordered same-file candidates before cross-library
    // lookup; before that fix this returned 'found-elsewhere' pointing at
    // "Device:R_Sma" itself, the identical failing lib_id.
    const r = await resolveLibrarySymbol('Device:R_Sma', [libDir]);
    expect(r.status).toBe('no-symbol');
    if (r.status === 'no-symbol') {
      expect(r.candidates).toContain('R_Small');
    }
  });

  it('resolveLibrarySymbol resolves a fuzzy cross-library suggestion end to end', async () => {
    const first = await resolveLibrarySymbol('Sensor_Wrong:SHT40', [libDir]);
    expect(first.status).toBe('found-elsewhere');
    if (first.status !== 'found-elsewhere') return;
    const suggested = first.libIds[0]!;
    expect(suggested).toBe('Sensor_Humidity:SHT4x');
    const second = await resolveLibrarySymbol(suggested, [libDir]);
    expect(second.status).toBe('ok');
  });

  // Finding 6 (review round 2): the wrong-nickname-but-library-exists path
  // through resolveLibrarySymbol, exercised via verify_symbols's shape
  // (Sensor_Humidity:SHT40 guessed correctly by file, wrong by part name),
  // as opposed to the drafting engine's SymbolSource, which the round-1 tests
  // already cover.
  it('a guessed library that exists, but lacks the name, still finds the real symbol elsewhere', async () => {
    const r = await resolveLibrarySymbol('Sensor_Humidity:SHT40', [libDir]);
    expect(r.status).toBe('found-elsewhere');
    if (r.status === 'found-elsewhere') expect(r.libIds).toEqual(['Sensor_Humidity:SHT4x']);
  });

  // Finding 2 (review round 2): the reorder that fixed the self-suggestion
  // regression introduced its own regression, an exact cross-library hit
  // pre-empted by a junk same-file candidate. Real stock Device.kicad_sym
  // has a symbol literally named "L" (inductor), and any query containing
  // the letter L (e.g. "LM358") trivially substring-matches it — this is
  // exactly the reviewer's live repro (Device:LM358), reproduced here with a
  // synthetic fixture so the test does not depend on the real KiCad library.
  it('an exact cross-library hit outranks a junk short same-file candidate', async () => {
    const junkDir = await mkdtemp(path.join(tmpdir(), 'copperhead-junk-'));
    try {
      await writeFile(
        path.join(junkDir, 'Device.kicad_sym'),
        `(kicad_symbol_lib (version 20251024) (generator test)\n  (symbol "L" (pin_numbers hide) (pin_names (offset 0))))`,
        'utf8',
      );
      await writeFile(
        path.join(junkDir, 'Amplifier_Operational.kicad_sym'),
        `(kicad_symbol_lib (version 20251024) (generator test)\n  (symbol "LM358" (pin_numbers hide) (pin_names (offset 0))))`,
        'utf8',
      );
      const r = await resolveLibrarySymbol('Device:LM358', [junkDir]);
      expect(r.status).toBe('found-elsewhere');
      if (r.status === 'found-elsewhere') expect(r.libIds).toEqual(['Amplifier_Operational:LM358']);
    } finally {
      await rm(junkDir, { recursive: true, force: true });
    }
  });

  // Finding 4 (review round 2): an exact hit and a fuzzy hit for the same
  // query must not be reported together — only the exact one, so the agent
  // is never invited to consider a wrong-but-plausible-looking alternative
  // alongside the right answer.
  it('an exact hit suppresses a coexisting fuzzy hit, not just a same-lib fuzzy one', async () => {
    const mixedDir = await mkdtemp(path.join(tmpdir(), 'copperhead-mixed-'));
    try {
      await writeFile(
        path.join(mixedDir, 'Exact.kicad_sym'),
        `(kicad_symbol_lib (version 20251024) (generator test)\n  (symbol "Widget123" (pin_numbers hide) (pin_names (offset 0))))`,
        'utf8',
      );
      await writeFile(
        path.join(mixedDir, 'Fuzzy.kicad_sym'),
        `(kicad_symbol_lib (version 20251024) (generator test)\n  (symbol "Widget12x" (pin_numbers hide) (pin_names (offset 0))))`,
        'utf8',
      );
      const matches = await findSymbolAcrossLibraries('Widget123', [mixedDir], 'Nowhere');
      // both a real exact hit and a real fuzzy hit exist in the raw scan
      expect(matches.some((m) => m.exact)).toBe(true);
      expect(matches.some((m) => !m.exact)).toBe(true);
      const ids = crossLibraryIds(matches);
      expect(ids).toEqual(['Exact:Widget123']);
    } finally {
      await rm(mixedDir, { recursive: true, force: true });
    }
  });

  it('a short/generic query is capped rather than returning every generic library', async () => {
    // "R" is a real canonical symbol name (Device:R), so an exact hit exists
    // and must collapse the result to that one hit, not every library whose
    // name happens to contain the letter R.
    const r = await resolveLibrarySymbol('Nowhere:R', [libDir]);
    expect(r.status).toBe('found-elsewhere');
    if (r.status === 'found-elsewhere') expect(r.libIds).toEqual(['Device:R']);
  });
});

// Finding 1 (review round 2): a nickname the project deliberately vendors
// (the drafting engine's own generated power symbols) must never be reported
// as a "wrong library, use X instead" correction just because it is absent
// from the installed search dirs — it is absent on purpose.
describe('verifySchematicSymbols: vendored libraries are not "wrong", just absent', () => {
  it('a vendored nickname reports no-library, not found-elsewhere, when repoRoot is given', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-vendored-'));
    const libDir = await mkdtemp(path.join(tmpdir(), 'copperhead-vendored-libs-'));
    try {
      // A stock library that happens to also define a symbol named "GND" —
      // standing in for the real stock `power` library, which the project's
      // own vendored `copperhead_power` nickname must not be confused with.
      await writeFile(
        path.join(libDir, 'power.kicad_sym'),
        `(kicad_symbol_lib (version 20251024) (generator test)\n  (symbol "GND" (power)\n    (pin power_in line (at 0 0 90) (length 0) (name "GND") (number "1"))\n  ))`,
        'utf8',
      );
      const src = new SymbolSource(repo, [libDir]);
      await src.vendorGenerated(
        'copperhead_power:GND',
        '\n\t(symbol "GND" (power)\n\t\t(pin power_in line (at 0 0 90) (length 0) (name "GND") (number "1"))\n\t)',
      );
      const sch = `(kicad_sch (version 20251024) (generator test)
  (lib_symbols
    (symbol "copperhead_power:GND" (power)
      (pin power_in line (at 0 0 90) (length 0) (name "GND") (number "1"))
    )
  )
)`;
      const schPath = path.join(repo, 'x.kicad_sch');
      await writeFile(schPath, sch, 'utf8');

      const withoutRoot = await verifySchematicSymbols(schPath, { KICAD_SYMBOL_DIR: libDir });
      // Old (and still default-for-unaware-callers) behavior: bad advice.
      expect(withoutRoot.findings[0]!.kind).toBe('wrong-library');

      const withRoot = await verifySchematicSymbols(schPath, { KICAD_SYMBOL_DIR: libDir }, repo);
      expect(withRoot.findings[0]!.kind).toBe('no-library');
      expect(withRoot.skipped).toBe(1);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(libDir, { recursive: true, force: true });
    }
  });
});

describe('symbolSearchDirs: Windows version-directory discovery', () => {
  let root: string;
  let versionDir: string;

  beforeAll(async () => {
    // Stand-in for "C:\Program Files\KiCad": a version-numbered child holding
    // the real symbols directory, the layout every real Windows install uses.
    // symbolSearchDirs builds the version path by string concatenation with
    // forward slashes (matching a Windows-accepted `C:/...` root), not
    // path.join, so the expected values here must be built the same way.
    root = (await mkdtemp(path.join(tmpdir(), 'copperhead-kicadroot-'))).split(path.sep).join('/');
    versionDir = `${root}/10.0/share/kicad/symbols`;
    await mkdir(versionDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // `symbolSearchDirs` also checks the hardcoded Linux/macOS default paths
  // unconditionally, regardless of the `winRoot` test seam: on a machine that
  // actually has KiCad installed at one of those (any real developer or CI
  // box capable of running this tool at all), asserting the whole return
  // value fails not because discovery is wrong, but because something else
  // real is also present. Assert on the discovered subset instead, so the
  // test states the actual contract independently of what else is installed.
  const discovered = (dirs: string[]): string[] => dirs.filter((d) => d.startsWith(root));

  it('discovers a version-numbered directory when no env override is set', async () => {
    const dirs = await symbolSearchDirs({}, root);
    expect(discovered(dirs)).toEqual([versionDir]);
  });

  it('prefers the newest version when more than one is installed', async () => {
    const older = `${root}/8.0/share/kicad/symbols`;
    await mkdir(older, { recursive: true });
    try {
      const dirs = discovered(await symbolSearchDirs({}, root));
      expect(dirs[0]).toBe(versionDir); // 10.0 sorts before 8.0
      expect(dirs).toContain(older);
    } finally {
      await rm(`${root}/8.0`, { recursive: true, force: true });
    }
  });

  it('an env override skips Windows auto-discovery entirely, even when set', async () => {
    // Regression: symbolSearchDirs used to run the Windows version-directory
    // scan unconditionally, so a caller pinning KICAD_SYMBOL_DIR at an
    // isolated directory (this repo's own tests, or a pinned library set)
    // could silently get the real machine's KiCad install appended too.
    // Points the override at an unrelated directory (not `versionDir`, which
    // sits under `root`) so the assertion states the real contract: discovery
    // under `root` did not run, independent of whether the override directory
    // itself happens to overlap with anything else.
    const envDir = await mkdtemp(path.join(tmpdir(), 'copperhead-envdir-'));
    try {
      const dirs = await symbolSearchDirs({ KICAD_SYMBOL_DIR: envDir }, root);
      expect(dirs).toContain(envDir);
      expect(dirs.some((d) => d.startsWith(root))).toBe(false);
    } finally {
      await rm(envDir, { recursive: true, force: true });
    }
  });
});
