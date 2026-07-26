import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { parseBom, HEADER_ALIASES, norm } from '../kicad/bom-export.js';
import { verifyMpn, type VerificationResult } from '../kicad/catalog.js';

export class VerificationError extends Error {}

export interface VerifyPartsOptions {
  repoRoot: string;
  update?: boolean;
  strict?: boolean;
}

export interface VerifyPartsResult {
  ok: boolean;
  results: VerificationResult[];
}

/**
 * Updates BOM.md LCSC column for resolved parts.
 */
export function updateBomLcsc(md: string, mpnToLcsc: Map<string, string>): { updatedMd: string; updatedCount: number } {
  const lineEnd = md.includes('\r\n') ? '\r\n' : '\n';
  const lines = md.split(/\r?\n/);
  
  let headerRowIdx = -1;
  let lcscColIdx = -1;
  let mpnColIdx = -1;
  
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] || '').trim();
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // separator
    
    if (cells.some((c) => norm(c) === 'refdes' || norm(c) === 'reference' || norm(c) === 'designator')) {
      headerRowIdx = i;
      cells.forEach((c, idx) => {
        const field = HEADER_ALIASES[norm(c)];
        if (field === 'lcsc') lcscColIdx = idx;
        if (field === 'mpn') mpnColIdx = idx;
      });
      break;
    }
  }
  
  if (headerRowIdx === -1 || mpnColIdx === -1 || lcscColIdx === -1) {
    return { updatedMd: md, updatedCount: 0 };
  }
  
  let updatedCount = 0;
  const updatedLines = [...lines];
  
  for (let i = headerRowIdx + 1; i < lines.length; i++) {
    const line = lines[i] || '';
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    
    const cells = trimmed.split('|').slice(1, -1).map(c => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // separator
    
    const mpn = cells[mpnColIdx];
    if (mpn) {
      const resolvedLcsc = mpnToLcsc.get(mpn.trim().toLowerCase());
      if (resolvedLcsc && cells[lcscColIdx] !== resolvedLcsc) {
        cells[lcscColIdx] = resolvedLcsc;
        updatedCount++;
        updatedLines[i] = `| ${cells.join(' | ')} |`;
      }
    }
  }
  
  return { updatedMd: updatedLines.join(lineEnd), updatedCount };
}

/**
 * Runs part verification on BOM.md against LCSC distributor catalog.
 */
export async function runVerifyParts(opts: VerifyPartsOptions): Promise<VerifyPartsResult> {
  const config = await loadConfig(opts.repoRoot);
  const bomPath = path.join(opts.repoRoot, config.docs, 'BOM.md');
  if (!existsSync(bomPath)) {
    throw new VerificationError(
      `no ${path.join(config.docs, 'BOM.md')} to verify — run copperhead init on an existing project, or copperhead create`,
    );
  }

  const bomContent = await readFile(bomPath, 'utf8');
  const rows = parseBom(bomContent);

  const uniqueMpns = [...new Set(rows.map(r => r.mpn.trim()).filter(m => m.length > 0))];
  const mpnResolutions = new Map<string, { status: string; lcscCode?: string }>();

  // Fetch resolutions in parallel
  await Promise.all(
    uniqueMpns.map(async (mpn) => {
      try {
        const res = await verifyMpn(mpn);
        mpnResolutions.set(mpn.toLowerCase(), {
          status: res.status,
          lcscCode: res.item?.lcscCode,
        });
      } catch (err) {
        // Degrade connection errors to NOT FOUND / failed state for strict mode
        mpnResolutions.set(mpn.toLowerCase(), {
          status: 'NOT FOUND',
        });
      }
    })
  );

  const results: VerificationResult[] = rows.map((row) => {
    const cleanMpn = row.mpn.trim();
    if (cleanMpn.length === 0) {
      return {
        refdes: row.refdes,
        mpn: '',
        status: 'NOT FOUND',
      };
    }
    const resolution = mpnResolutions.get(cleanMpn.toLowerCase());
    return {
      refdes: row.refdes,
      mpn: cleanMpn,
      status: (resolution?.status ?? 'NOT FOUND') as any,
      lcscCode: resolution?.lcscCode || row.lcsc || undefined,
    };
  });

  // Check overall validity
  const hasNotFound = results.some((r) => r.status === 'NOT FOUND');
  const hasNoStock = results.some((r) => r.status === 'NO STOCK');
  const ok = opts.strict ? (!hasNotFound && !hasNoStock) : !hasNotFound;

  // Print tabular summary to stdout
  console.log(`\nVerifying BOM parts against catalog...`);
  console.log(`Refdes`.padEnd(10) + `MPN`.padEnd(25) + `Status`.padEnd(15) + `LCSC`);
  console.log(`-`.repeat(60));
  for (const r of results) {
    const mpnStr = r.mpn || '(empty)';
    console.log(
      r.refdes.padEnd(10) +
      mpnStr.padEnd(25) +
      r.status.padEnd(15) +
      (r.lcscCode || '-')
    );
  }
  console.log();

  if (opts.update) {
    const mpnToLcsc = new Map<string, string>();
    for (const [mpn, res] of mpnResolutions.entries()) {
      if (res.lcscCode) {
        mpnToLcsc.set(mpn, res.lcscCode);
      }
    }
    const { updatedMd, updatedCount } = updateBomLcsc(bomContent, mpnToLcsc);
    if (updatedCount > 0) {
      await writeFile(bomPath, updatedMd, 'utf8');
      console.log(`Updated ${updatedCount} LCSC code(s) in BOM.md.\n`);
    }
  }

  return { ok, results };
}
