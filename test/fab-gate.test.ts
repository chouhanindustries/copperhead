import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { tempFixtureRepo } from './helpers.js';
import { runCheck } from '../src/commands/check.js';
import { runInit } from '../src/memory/scaffold.js';
import { loadConfig } from '../src/config.js';
import { computeFileHash } from '../src/kicad/fab.js';

async function setupMatchingPcbAndBom(repo: string): Promise<void> {
  const config = await loadConfig(repo);
  await mkdir(path.join(repo, 'outputs'), { recursive: true });

  if (config.board) {
    const pcbPath = path.join(repo, config.board);
    const pcbText = await readFile(pcbPath, 'utf8');
    const pcbWithFps = pcbText.replace(
      '(net 0 "")',
      `(net 0 "")
  (footprint "Resistor_SMD:R_0603_1608Metric" (property "Reference" "R1"))
  (footprint "Resistor_SMD:R_0603_1608Metric" (property "Reference" "R2"))
  (footprint "RF_Module:ESP32-S3-MINI-1" (property "Reference" "U1"))`,
    );
    await writeFile(pcbPath, pcbWithFps, 'utf8');

    const boardHash = await computeFileHash(pcbPath);
    const configPath = path.join(repo, '.copperhead', 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({ ...config, exportHash: { boardHash, exportedAt: new Date().toISOString() } }),
      'utf8',
    );
  }

  const bomPath = path.join(repo, 'docs', 'BOM.md');
  const bomContent = `# Bill of Materials

| Refdes | Qty | Value | Footprint | MPN | Sourcing |
|---|---|---|---|---|---|
| R1 | 1 | 10k | Resistor_SMD:R_0603_1608Metric | RC0603FR-0710KL | verified |
| R2 | 1 | 1k | Resistor_SMD:R_0603_1608Metric | RC0603FR-071KL | verified |
| U1 | 1 | ESP32-S3-MINI | RF_Module:ESP32-S3-MINI-1 | ESP32-S3-MINI-1-N8 | verified |
`;
  await writeFile(bomPath, bomContent, 'utf8');
}

describe('Fabrication Release Gate (check --fab)', () => {
  it('plain check output format remains unchanged when --fab is omitted', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const res = await runCheck(repo, () => {});
      expect(res.fab).toBeUndefined();
      expect(res.ok).toBe(true);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('runs all 5 fab release gate checks on clean initialized project', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      await setupMatchingPcbAndBom(repo);

      const res = await runCheck(repo, () => {}, { fab: true });
      expect(res.fab).toBeDefined();
      expect(res.fab?.routing.status).toBe('pass');
      expect(res.fab?.bom.status).toBe('pass');
      expect(res.fab?.schPcbMatch.status).toBe('pass');
      expect(res.fab?.outputs.status).toBe('pass');
      expect(res.fab?.docs.status).toBe('pass');
      expect(res.fab?.ok).toBe(true);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('warns on UNVERIFIED BOM row by default and fails under --strict', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      await setupMatchingPcbAndBom(repo);

      const bomPath = path.join(repo, 'docs', 'BOM.md');
      const bomContent = `# Bill of Materials

| Refdes | Qty | Value | Footprint | MPN | Sourcing |
|---|---|---|---|---|---|
| R1 | 1 | 10k | Resistor_SMD:R_0603_1608Metric | RC0603FR-0710KL | UNVERIFIED |
| R2 | 1 | 1k | Resistor_SMD:R_0603_1608Metric | RC0603FR-071KL | verified |
| U1 | 1 | ESP32-S3-MINI | RF_Module:ESP32-S3-MINI-1 | ESP32-S3-MINI-1-N8 | verified |
`;
      await writeFile(bomPath, bomContent, 'utf8');

      const resWarn = await runCheck(repo, () => {}, { fab: true });
      expect(resWarn.fab?.bom.status).toBe('warn');
      expect(resWarn.fab?.ok).toBe(true);

      const resStrict = await runCheck(repo, () => {}, { fab: true, strict: true });
      expect(resStrict.fab?.bom.status).toBe('fail');
      expect(resStrict.fab?.ok).toBe(false);
      expect(resStrict.ok).toBe(false);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('fails on missing MPN in BOM.md', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const bomPath = path.join(repo, 'docs', 'BOM.md');
      const bomContent = `# Bill of Materials

| Refdes | Qty | Value | Footprint | MPN | Sourcing |
|---|---|---|---|---|---|
| R1 | 1 | 10k | Resistor_SMD:R_0603_1608Metric | - | verified |
`;
      await writeFile(bomPath, bomContent, 'utf8');

      const res = await runCheck(repo, () => {}, { fab: true });
      expect(res.fab?.bom.status).toBe('fail');
      expect(res.ok).toBe(false);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('fails on missing LAYOUT.md ## Draft quality section', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const layoutPath = path.join(repo, 'docs', 'LAYOUT.md');
      await writeFile(layoutPath, '# Layout Guidelines\n\nNo draft section here.', 'utf8');

      const res = await runCheck(repo, () => {}, { fab: true });
      expect(res.fab?.docs.status).toBe('fail');
      expect(res.ok).toBe(false);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('completes quickly with zero network calls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const start = Date.now();
      const res = await runCheck(repo, () => {}, { fab: true });
      const elapsed = Date.now() - start;

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(elapsed).toBeLessThan(60_000);
      expect(res.fab).toBeDefined();
    } finally {
      fetchSpy.mockRestore();
      await cleanup();
    }
  }, 120_000);
});
