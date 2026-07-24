import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { dirHasContent, verifyOutputsStage, verifyFirmwareStage } from '../src/commands/create-enhancements';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('create-enhancements', () => {
  describe('dirHasContent', () => {
    it('returns false for non-existent directory', async () => {
      const nonExistent = path.join(tmpdir(), `copperhead-test-${Date.now()}`);
      expect(await dirHasContent(nonExistent)).toBe(false);
    });

    it('returns false for empty directory', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-empty-'));
      expect(await dirHasContent(dir)).toBe(false);
    });

    it('returns true for directory with non-empty file', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-content-'));
      await writeFile(path.join(dir, 'test.txt'), 'hello');
      expect(await dirHasContent(dir)).toBe(true);
      await rm(dir, { recursive: true, force: true });
    });

    it('returns false for directory with only empty files', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-emptyfiles-'));
      await writeFile(path.join(dir, 'empty.txt'), '');
      expect(await dirHasContent(dir)).toBe(false);
      await rm(dir, { recursive: true, force: true });
    });

    it('recurses into subdirectories', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-nested-'));
      await mkdir(path.join(dir, 'subdir'));
      await writeFile(path.join(dir, 'subdir', 'file.txt'), 'content');
      expect(await dirHasContent(dir)).toBe(true);
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe('verifyOutputsStage', () => {
    let repoRoot: string;

    beforeEach(async () => {
      repoRoot = await mkdtemp(path.join(tmpdir(), 'copperhead-outputs-'));
    });

    afterEach(async () => {
      await rm(repoRoot, { recursive: true, force: true });
    });

    it('returns false when outputs directory missing', async () => {
      const result = await verifyOutputsStage(repoRoot);
      expect(result.ok).toBe(false);
      expect(result.missing).toContain('outputs/ directory missing');
    });

    it('returns false when outputs is empty', async () => {
      await mkdir(path.join(repoRoot, 'outputs'));
      const result = await verifyOutputsStage(repoRoot);
      expect(result.ok).toBe(false);
    });

    it('returns true when outputs has all required artifacts', async () => {
      await mkdir(path.join(repoRoot, 'outputs'));
      await writeFile(path.join(repoRoot, 'outputs', 'top.gbr'), 'gerber content');
      await writeFile(path.join(repoRoot, 'outputs', 'drill.tap'), 'drill content');
      await writeFile(path.join(repoRoot, 'outputs', 'BOM.csv'), 'ref,mpn,qty');
      const result = await verifyOutputsStage(repoRoot);
      expect(result.ok).toBe(true);
      expect(result.found).toContain('gerber files');
      expect(result.found).toContain('drill files (1)');
      expect(result.found).toContain('BOM files (1)');
    });
  });

  describe('verifyFirmwareStage', () => {
    let repoRoot: string;

    beforeEach(async () => {
      repoRoot = await mkdtemp(path.join(tmpdir(), 'copperhead-firmware-'));
    });

    afterEach(async () => {
      await rm(repoRoot, { recursive: true, force: true });
    });

    it('returns false when firmware directory missing', async () => {
      const result = await verifyFirmwareStage(repoRoot);
      expect(result.ok).toBe(false);
      expect(result.codeFiles).toBe(0);
    });

    it('returns true when firmware has source files', async () => {
      await mkdir(path.join(repoRoot, 'firmware'));
      await writeFile(path.join(repoRoot, 'firmware', 'main.c'), 'int main() { return 0; }');
      const result = await verifyFirmwareStage(repoRoot);
      expect(result.ok).toBe(true);
      expect(result.codeFiles).toBeGreaterThan(0);
    });

    it('returns false when firmware has only non-source files', async () => {
      await mkdir(path.join(repoRoot, 'firmware'));
      await writeFile(path.join(repoRoot, 'firmware', 'readme.txt'), 'README');
      const result = await verifyFirmwareStage(repoRoot);
      expect(result.ok).toBe(false);
    });

    it('counts python files as code', async () => {
      await mkdir(path.join(repoRoot, 'firmware'));
      await writeFile(path.join(repoRoot, 'firmware', 'flash.py'), 'print("hello")');
      const result = await verifyFirmwareStage(repoRoot);
      expect(result.ok).toBe(true);
      expect(result.codeFiles).toBe(1);
    });
  });
});
