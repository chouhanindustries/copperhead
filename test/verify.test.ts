import { describe, it, expect, vi, afterEach } from 'vitest';
import { runVerifyParts, VerificationError } from '../src/commands/verify.js';
import { verifyMpn } from '../src/kicad/catalog.js';
import { runExportBom } from '../src/commands/export.js';
import { runCheck } from '../src/commands/check.js';
import { tempFixtureRepo } from './helpers.js';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

describe('Part verification (verify-parts-networked)', () => {
  const fetchSpy = vi.spyOn(global, 'fetch');

  afterEach(() => {
    fetchSpy.mockReset();
  });

  it('verifyMpn handles RESOLVED, NO STOCK, and NOT FOUND from catalog responses', async () => {
    // 1. RESOLVED case
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        components: [
          { lcsc: 12345, mfr: 'ESP32-S3-WROOM-1', package: 'SMD', stock: 100, price: 2.5 }
        ]
      })
    } as Response);
    const r1 = await verifyMpn('ESP32-S3-WROOM-1');
    expect(r1.status).toBe('RESOLVED');
    expect(r1.item?.lcscCode).toBe('C12345');

    // 2. NO STOCK case (case-insensitive match)
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        components: [
          { lcsc: 67890, mfr: 'esp32-s3-wroom-1', package: 'SMD', stock: 0, price: 2.5 }
        ]
      })
    } as Response);
    const r2 = await verifyMpn('ESP32-S3-WROOM-1');
    expect(r2.status).toBe('NO STOCK');
    expect(r2.item?.lcscCode).toBe('C67890');

    // 3. NOT FOUND case
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        components: []
      })
    } as Response);
    const r3 = await verifyMpn('ESP32-S3-WROOM-1');
    expect(r3.status).toBe('NOT FOUND');
  });

  it('runVerifyParts parses BOM.md, runs query, and reports tabular status', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const bomPath = path.join(repo, 'docs', 'BOM.md');
      await mkdir(path.dirname(bomPath), { recursive: true });
      await writeFile(bomPath, `# BOM
| Refdes | Value | Footprint | MPN | Manufacturer | LCSC |
|---|---|---|---|---|---|
| R1 | 10k | R_0603 | RC0603FR-0710KL | Yageo | |
| R2 | 1k | R_0603 | MOCK-OUT-OF-STOCK | | |
| U1 | ESP | SMD | MOCK-NOT-FOUND | | |
`, 'utf8');

      // Mock the fetch resolutions
      // RC0603FR-0710KL
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          components: [{ lcsc: 25804, mfr: 'RC0603FR-0710KL', package: '0603', stock: 500, price: 0.01 }]
        })
      } as Response);
      // MOCK-OUT-OF-STOCK
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          components: [{ lcsc: 999, mfr: 'MOCK-OUT-OF-STOCK', package: '0603', stock: 0, price: 0.1 }]
        })
      } as Response);
      // MOCK-NOT-FOUND
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          components: []
        })
      } as Response);

      const res = await runVerifyParts({ repoRoot: repo, strict: false });
      expect(res.ok).toBe(false); // fails overall since U1 is NOT FOUND
      expect(res.results).toHaveLength(3);
      expect(res.results[0]).toMatchObject({ refdes: 'R1', status: 'RESOLVED', lcscCode: 'C25804' });
      expect(res.results[1]).toMatchObject({ refdes: 'R2', status: 'NO STOCK', lcscCode: 'C999' });
      expect(res.results[2]).toMatchObject({ refdes: 'U1', status: 'NOT FOUND' });
    } finally {
      await cleanup();
    }
  });

  it('runVerifyParts --update rewrites BOM.md with resolved LCSC codes', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const bomPath = path.join(repo, 'docs', 'BOM.md');
      await mkdir(path.dirname(bomPath), { recursive: true });
      await writeFile(bomPath, `# BOM
| Refdes | Value | Footprint | MPN | Manufacturer | LCSC |
|---|---|---|---|---|---|
| R1 | 10k | R_0603 | RC0603FR-0710KL | Yageo | |
`, 'utf8');

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          components: [{ lcsc: 25804, mfr: 'RC0603FR-0710KL', package: '0603', stock: 500, price: 0.01 }]
        })
      } as Response);

      const res = await runVerifyParts({ repoRoot: repo, update: true });
      expect(res.ok).toBe(true);

      const content = await readFile(bomPath, 'utf8');
      expect(content).toContain('| R1 | 10k | R_0603 | RC0603FR-0710KL | Yageo | C25804 |');
    } finally {
      await cleanup();
    }
  });

  it('runVerifyParts --strict fails if any part is out of stock', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const bomPath = path.join(repo, 'docs', 'BOM.md');
      await mkdir(path.dirname(bomPath), { recursive: true });
      await writeFile(bomPath, `# BOM
| Refdes | Value | Footprint | MPN | Manufacturer | LCSC |
|---|---|---|---|---|---|
| R1 | 10k | R_0603 | RC0603FR-0710KL | Yageo | |
`, 'utf8');

      // Return out of stock
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          components: [{ lcsc: 25804, mfr: 'RC0603FR-0710KL', package: '0603', stock: 0, price: 0.01 }]
        })
      } as Response);

      const res = await runVerifyParts({ repoRoot: repo, strict: true });
      expect(res.ok).toBe(false); // fails strict check since stock is 0
    } finally {
      await cleanup();
    }
  });

  it('offline invariant: check and plain export bom make zero network calls', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      // 1. Run check
      await runCheck(repo, () => {});
      expect(fetchSpy).not.toHaveBeenCalled();

      // 2. Run plain export bom
      const bomPath = path.join(repo, 'docs', 'BOM.md');
      await mkdir(path.dirname(bomPath), { recursive: true });
      await writeFile(bomPath, `# BOM
| Refdes | Value | Footprint | MPN | Manufacturer | LCSC |
|---|---|---|---|---|---|
| R1 | 10k | Resistor_SMD:R_0603_1608Metric | RC0603FR-0710KL | Yageo | C25804 | pullup |
`, 'utf8');
      
      await runExportBom({
        repoRoot: repo,
        supplier: 'jlcpcb',
        boards: 1,
        spares: 10,
        includeUnverified: false
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });
});
