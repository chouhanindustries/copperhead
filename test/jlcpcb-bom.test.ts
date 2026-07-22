import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { emitJlcpcbBom, type NormalizedBomRow } from '../src/kicad/bom-export.js';

const fixtureDir = path.join(process.cwd(), 'test', 'fixtures', 'jlcpcb');

async function fixtureRows(): Promise<NormalizedBomRow[]> {
  return JSON.parse(await readFile(path.join(fixtureDir, 'bom.json'), 'utf8')) as NormalizedBomRow[];
}

describe('JLCPCB BOM emitter', () => {
  it('matches the committed golden CSV byte-for-byte', async () => {
    const result = emitJlcpcbBom(await fixtureRows());
    expect(result.csv).toBe(await readFile(path.join(fixtureDir, 'expected.csv'), 'utf8'));
  });

  it('reports excluded rows and includes UNVERIFIED rows when requested', async () => {
    const result = emitJlcpcbBom(await fixtureRows(), { includeUnverified: true });
    expect(result.warnings.map((warning) => warning.refdes)).toEqual(['D1', 'U1', 'C1']);
    expect(result.csv).toContain('"LED","D1"');
    expect(result.csv).toContain('"1uF","C1"');
    expect(result.csv).not.toContain('# Excluded');
  });

  it('can append warnings when the target format permits comments', async () => {
    const result = emitJlcpcbBom(await fixtureRows(), { includeWarningsInCsv: true });
    expect(result.csv).toContain('# Excluded D1: UNVERIFIED');
  });

  it('escapes CSV fields and ignores quantity arithmetic', () => {
    const result = emitJlcpcbBom([
      { refdes: 'R1', value: '10" special', footprint: 'F,1', mpn: 'X', quantity: 1 },
      { refdes: 'R2', value: '10" special', footprint: 'F,1', mpn: 'X', quantity: 500 },
    ]);
    expect(result.csv).toBe('Comment,Designator,Footprint,LCSC Part #\n"10"" special","R1,R2","F,1",""\n');
  });

  it('normalizes grouping fields, falls back from empty status, and deduplicates references', () => {
    const result = emitJlcpcbBom([
      { refdes: ' R10 ', value: ' 10k ', footprint: ' R_0603 ', mpn: 'X', lcsc: ' C1 ' },
      { refdes: 'R2', value: '10k', footprint: 'R_0603', mpn: 'X', lcsc: 'C1', status: '', verification: 'UNVERIFIED' },
      { refdes: 'R2', value: '10k', footprint: 'R_0603', mpn: 'X', lcsc: 'C1' },
    ], { includeUnverified: true });

    expect(result.csv).toContain('"10k","R2,R10","R_0603","C1"');
  });

  it('always excludes an UNVERIFIED MPN marker and supports the verification alias', () => {
    const result = emitJlcpcbBom([
      { refdes: 'U1', value: 'part', footprint: 'F', mpn: 'UNVERIFIED' },
      { refdes: 'U2', value: 'part', footprint: 'F', mpn: 'X', verification: 'UNVERIFIED' },
    ], { includeUnverified: true });

    expect(result.csv).toBe('Comment,Designator,Footprint,LCSC Part #\n"part","U2","F",""\n');
    expect(result.warnings.map((warning) => warning.refdes)).toEqual(['U1', 'U2']);
  });

  it('emits only the header for empty input', () => {
    expect(emitJlcpcbBom([]).csv).toBe('Comment,Designator,Footprint,LCSC Part #\n');
  });
});
