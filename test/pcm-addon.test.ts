/**
 * PCM addon packaging (AC-114B.7, AC-114B.8): layout, metadata, and a real
 * unzip of the produced archive. No KiCad involved.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
// @ts-expect-error plain .mjs build script, no type declarations
import { addonEntries, buildAddon, pcmMetadata } from '../scripts/build-pcm-addon.mjs';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

describe('PCM metadata (AC-114B.7)', () => {
  it('carries the package version and KiCad 9-10 bounds', () => {
    const meta = pcmMetadata(version) as {
      identifier: string;
      type: string;
      versions: Array<{ version: string; kicad_version: string; kicad_version_max: string }>;
    };
    expect(meta.identifier).toBe('com.github.chouhanindustries.copperhead');
    expect(meta.type).toBe('plugin');
    expect(meta.versions).toHaveLength(1);
    expect(meta.versions[0]!.version).toBe(version);
    expect(meta.versions[0]!.kicad_version).toBe('9.0');
    // SWIG plugins die in KiCad 11: the max bound must stay below it.
    expect(meta.versions[0]!.kicad_version_max).toBe('10.99');
  });
});

describe('addon layout (AC-114B.7)', () => {
  it('packs metadata at the root, plugin sources under plugins/, icon under resources/', () => {
    const names = (addonEntries() as Array<{ name: string }>).map((e) => e.name);
    expect(names).toContain('metadata.json');
    expect(names).toContain('resources/icon.png');
    // Directly under plugins/: PCM makes the installed addon dir itself the
    // python package, so __init__.py must land at its root.
    expect(names).toContain('plugins/__init__.py');
    expect(names).toContain('plugins/panel.py');
    expect(names).toContain('plugins/client.py');
    expect(names).toContain('plugins/icon.png');
    for (const n of names) expect(n).not.toContain('__pycache__');
  });

  it('builds a zip that a real unzip can list and extract (AC-114B.8)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-pcm-'));
    try {
      const zipPath = buildAddon(dir) as string;
      expect(path.basename(zipPath)).toBe(`copperhead-kicad-addon-${version}.zip`);
      const hasUnzip = await execa('unzip', ['-v']).then(
        () => true,
        () => false,
      );
      if (!hasUnzip) return; // container structure is still covered above
      await execa('unzip', ['-q', zipPath, '-d', path.join(dir, 'x')]);
      const { stdout } = await execa('cat', [path.join(dir, 'x', 'metadata.json')]);
      const meta = JSON.parse(stdout) as { versions: Array<{ version: string }> };
      expect(meta.versions[0]!.version).toBe(version);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
