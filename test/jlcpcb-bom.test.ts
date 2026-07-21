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
    expect(result.warnings.map((warning) => warning.refdes)).toEqual(['U1']);
    expect(result.csv).toContain('"LED","D1"');
    expect(result.csv).toContain('"1uF","C1"');
  });

  it('escapes CSV fields and ignores quantity arithmetic', () => {
    const result = emitJlcpcbBom([
      { refdes: 'R1', value: '10" special', footprint: 'F,1', mpn: 'X', quantity: 1 },
      { refdes: 'R2', value: '10" special', footprint: 'F,1', mpn: 'X', quantity: 500 },
    ]);
    expect(result.csv).toBe('Comment,Designator,Footprint,LCSC Part #\n"10"" special","R1,R2","F,1",""\n');
  });
});
