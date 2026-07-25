import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { tempFixtureRepo, hasKicadCli } from './helpers.js';
import { runInit } from '../src/memory/scaffold.js';
import { loadConfig } from '../src/config.js';
import { computeFileHash, runFabGateCheck } from '../src/kicad/fab.js';

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

  const layoutPath = path.join(repo, 'docs', 'LAYOUT.md');
  const layoutContent = `# Layout intent\n\n## Draft quality\n\nPower and critical nets routed.`;
  await writeFile(layoutPath, layoutContent, 'utf8');
}

describe.runIf(hasKicadCli)('Fabrication Release Gate (check --fab)', () => {
  it('runs all 5 fab release gate checks on clean initialized project', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      await setupMatchingPcbAndBom(repo);
      const config = await loadConfig(repo);

      const fab = await runFabGateCheck(repo, config, {
        drcReport: { ok: true, source: 'drc', violations: [] },
      });
      expect(fab).toBeDefined();
      expect(fab.routing.status).toBe('pass');
      expect(fab.bom.status).toBe('pass');
      expect(fab.schPcbMatch.status).toBe('pass');
      expect(fab.outputs.status).toBe('pass');
      expect(fab.docs.status).toBe('pass');
      expect(fab.ok).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('warns on UNVERIFIED BOM row by default and fails under --strict', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      await setupMatchingPcbAndBom(repo);
      const config = await loadConfig(repo);

      const bomPath = path.join(repo, 'docs', 'BOM.md');
      const bomContent = `# Bill of Materials

| Refdes | Qty | Value | Footprint | MPN | Sourcing |
|---|---|---|---|---|---|
| R1 | 1 | 10k | Resistor_SMD:R_0603_1608Metric | RC0603FR-0710KL | UNVERIFIED |
| R2 | 1 | 1k | Resistor_SMD:R_0603_1608Metric | RC0603FR-071KL | verified |
| U1 | 1 | ESP32-S3-MINI | RF_Module:ESP32-S3-MINI-1 | ESP32-S3-MINI-1-N8 | verified |
`;
      await writeFile(bomPath, bomContent, 'utf8');

      const fabWarn = await runFabGateCheck(repo, config, {
        strict: false,
        drcReport: { ok: true, source: 'drc', violations: [] },
      });
      expect(fabWarn.bom.status).toBe('warn');
      expect(fabWarn.ok).toBe(true);

      const fabStrict = await runFabGateCheck(repo, config, {
        strict: true,
        drcReport: { ok: true, source: 'drc', violations: [] },
      });
      expect(fabStrict.bom.status).toBe('fail');
      expect(fabStrict.ok).toBe(false);
    } finally {
      await cleanup();
    }
  });

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

      const config = await loadConfig(repo);
      const fab = await runFabGateCheck(repo, config);
      expect(fab.bom.status).toBe('fail');
      expect(fab.ok).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('fails on missing LAYOUT.md ## Draft quality section', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const layoutPath = path.join(repo, 'docs', 'LAYOUT.md');
      await writeFile(layoutPath, '# Layout Guidelines\n\nNo draft section here.', 'utf8');

      const config = await loadConfig(repo);
      const fab = await runFabGateCheck(repo, config);
      expect(fab.docs.status).toBe('fail');
      expect(fab.ok).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('completes quickly with zero network calls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const config = await loadConfig(repo);
      const start = Date.now();
      const fab = await runFabGateCheck(repo, config);
      const elapsed = Date.now() - start;

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(elapsed).toBeLessThan(10_000);
      expect(fab).toBeDefined();
    } finally {
      fetchSpy.mockRestore();
      await cleanup();
    }
  });
});
