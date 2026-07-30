import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveKicadCli,
  resetKicadCliCache,
  setKicadFallbackBinaries,
  kicadCliVersion,
  KicadCliBadOverrideError,
  KicadCliMissingError,
} from '../src/kicad/cli.js';

describe('kicad-cli binary resolution', () => {
  const saved = process.env.COPPERHEAD_KICAD_CLI;
  let dir: string;

  beforeEach(async () => {
    resetKicadCliCache();
    dir = await mkdtemp(path.join(tmpdir(), 'copperhead-kicad-'));
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env.COPPERHEAD_KICAD_CLI;
    else process.env.COPPERHEAD_KICAD_CLI = saved;
    resetKicadCliCache();
    setKicadFallbackBinaries();
    await rm(dir, { recursive: true, force: true });
  });

  it('falls back to the PATH name when no override is set', () => {
    delete process.env.COPPERHEAD_KICAD_CLI;
    expect(resolveKicadCli()).toBe('kicad-cli');
  });

  it('honours COPPERHEAD_KICAD_CLI when the path exists', async () => {
    const bin = path.join(dir, process.platform === 'win32' ? 'kicad-cli.exe' : 'kicad-cli');
    await writeFile(bin, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(bin, 0o755);
    process.env.COPPERHEAD_KICAD_CLI = bin;
    expect(resolveKicadCli()).toBe(bin);
  });

  it('trims surrounding whitespace in the override', async () => {
    const bin = path.join(dir, process.platform === 'win32' ? 'kicad-cli.exe' : 'kicad-cli');
    await writeFile(bin, '#!/bin/sh\nexit 0\n', 'utf8');
    process.env.COPPERHEAD_KICAD_CLI = `  ${bin}  `;
    expect(resolveKicadCli()).toBe(bin);
  });

  it('refuses, naming the bad path, when the override does not exist', () => {
    const missing = path.join(dir, 'typo', process.platform === 'win32' ? 'kicad-cli.exe' : 'kicad-cli');
    process.env.COPPERHEAD_KICAD_CLI = missing;
    expect(() => resolveKicadCli()).toThrow(KicadCliBadOverrideError);
    try {
      resolveKicadCli();
    } catch (err) {
      const e = err as KicadCliBadOverrideError;
      expect(e.message).toContain(missing);
      expect(e.message).not.toMatch(/not found on PATH/);
    }
  });

  it('treats an empty or whitespace-only override as unset', () => {
    process.env.COPPERHEAD_KICAD_CLI = '   ';
    expect(resolveKicadCli()).toBe('kicad-cli');
  });

  it('reports the binary as missing when PATH has no kicad-cli and no bundle matches', async () => {
    delete process.env.COPPERHEAD_KICAD_CLI;
    setKicadFallbackBinaries([]);
    const savedPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      await expect(kicadCliVersion()).rejects.toBeInstanceOf(KicadCliMissingError);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });

  it.skipIf(process.platform === 'win32')('falls back to an app-bundle path when PATH has no kicad-cli', async () => {
    delete process.env.COPPERHEAD_KICAD_CLI;
    const bundle = path.join(dir, 'KiCad.app', 'Contents', 'MacOS', 'kicad-cli');
    await mkdir(path.dirname(bundle), { recursive: true });
    await writeFile(bundle, '#!/bin/sh\necho "9.0.1"\n', 'utf8');
    await chmod(bundle, 0o755);
    setKicadFallbackBinaries([path.join(dir, 'absent', 'kicad-cli'), bundle]);
    const savedPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      expect(await kicadCliVersion()).toBe('9.0.1');
      expect(resolveKicadCli()).toBe(bundle);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });

  it.skipIf(process.platform === 'win32')('refuses when an override that existed at resolve time disappears mid-session', async () => {
    const onPath = path.join(dir, 'path-bin');
    await mkdir(onPath, { recursive: true });
    const pathBinary = path.join(onPath, 'kicad-cli');
    await writeFile(pathBinary, '#!/bin/sh\necho "8.0.4"\n', 'utf8');
    await chmod(pathBinary, 0o755);

    const override = path.join(dir, 'custom-kicad');
    await writeFile(override, '#!/bin/sh\necho "9.9.9"\n', 'utf8');
    await chmod(override, 0o755);

    setKicadFallbackBinaries([]);
    const savedPath = process.env.PATH;
    process.env.PATH = onPath;
    try {
      process.env.COPPERHEAD_KICAD_CLI = override;
      expect(resolveKicadCli()).toBe(override);
      
      await rm(override, { force: true });

      await expect(kicadCliVersion()).rejects.toBeInstanceOf(KicadCliBadOverrideError);

      delete process.env.COPPERHEAD_KICAD_CLI;
      resetKicadCliCache();
      expect(await kicadCliVersion()).toBe('8.0.4');
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });

  it('caches the resolved binary until the cache is reset', async () => {
    delete process.env.COPPERHEAD_KICAD_CLI;
    expect(resolveKicadCli()).toBe('kicad-cli');
    const bin = path.join(dir, process.platform === 'win32' ? 'kicad-cli.exe' : 'kicad-cli');
    await writeFile(bin, '#!/bin/sh\nexit 0\n', 'utf8');
    process.env.COPPERHEAD_KICAD_CLI = bin;
    expect(resolveKicadCli()).toBe('kicad-cli');
    resetKicadCliCache();
    expect(resolveKicadCli()).toBe(bin);
  });
});