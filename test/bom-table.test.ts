import { describe, it, expect } from 'vitest';
import { parseMarkdownTables, isHeader, parseBomTable } from '../src/memory/bom-table.js';

describe('parseMarkdownTables', () => {
  it('parses a well-formed table, skipping the separator row', () => {
    const md = [
      '# Bill of Materials',
      '',
      '| Refdes | Value | Footprint | MPN | Rationale |',
      '|---|---|---|---|---|',
      '| R1 | 10k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | extracted from schematic |',
      '| U1 | ATmega328 | Package_QFP:TQFP-32 | ATMEGA328-AU | extracted from schematic |',
    ].join('\n');
    const rows = parseMarkdownTables(md);
    // header + 2 data rows; separator is dropped
    expect(rows).toHaveLength(3);
    expect(rows[1]!.cells[0]).toBe('R1');
    expect(rows[2]!.cells[0]).toBe('U1');
  });

  it('parses multiple tables in one document', () => {
    const md = [
      '| Refdes | Value |',
      '|---|---|',
      '| R1 | 10k |',
      '',
      '| Refdes | Pin | Name | Net | Notes |',
      '|---|---|---|---|---|',
      '| U1 | 5 | GPIO14 | KEY_DAH | |',
    ].join('\n');
    const rows = parseMarkdownTables(md);
    expect(rows).toHaveLength(4);
  });

  it('ignores prose lines that do not start with a pipe', () => {
    const md = 'Every part: refdes, MPN, value, package.\n\n| Refdes | Value |\n|---|---|\n| R1 | 10k |\n';
    const rows = parseMarkdownTables(md);
    expect(rows).toHaveLength(2); // header + one data row
  });

  it('returns an empty array for a document with no tables', () => {
    expect(parseMarkdownTables('# Just prose\n\nNo tables here.\n')).toEqual([]);
  });

  it('does not throw on a malformed / ragged table', () => {
    const md = [
      '| Refdes | Value | Footprint | MPN | Rationale |',
      '|---|---|---|---|---|',
      '| R1 | 10k |', // short row, missing trailing cells
      '| | 47k | Resistor_SMD:R_0603_1608Metric | | |', // missing refdes
      '||||', // degenerate row
    ].join('\n');
    expect(() => parseMarkdownTables(md)).not.toThrow();
    const rows = parseMarkdownTables(md);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('isHeader', () => {
  it('recognizes a BOM header row (Refdes)', () => {
    expect(isHeader({ cells: ['Refdes', 'Value', 'Footprint', 'MPN', 'Rationale'] })).toBe(true);
  });

  it('recognizes a PINOUT header row (Pin)', () => {
    expect(isHeader({ cells: ['Refdes', 'Pin', 'Name', 'Net', 'Notes'] })).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isHeader({ cells: ['REFDES', 'Value'] })).toBe(true);
  });

  it('returns false for a data row', () => {
    expect(isHeader({ cells: ['R1', '10k', 'Resistor_SMD:R_0603_1608Metric', 'UNVERIFIED', ''] })).toBe(false);
  });
});

describe('parseBomTable', () => {
  const header = '| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|';

  it('parses a well-formed BOM into typed rows', () => {
    const md = `${header}\n| R1 | 10k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | extracted from schematic |\n`;
    const rows = parseBomTable(md);
    expect(rows).toEqual([
      {
        refdes: 'R1',
        value: '10k',
        footprint: 'Resistor_SMD:R_0603_1608Metric',
        mpn: 'UNVERIFIED',
        flags: ['UNVERIFIED'],
      },
    ]);
  });

  it('flags a row with a real MPN as unflagged', () => {
    const md = `${header}\n| U1 | ATmega328 | Package_QFP:TQFP-32 | ATMEGA328-AU | verified against datasheet |\n`;
    const rows = parseBomTable(md);
    expect(rows[0]!.flags).toEqual([]);
    expect(rows[0]!.mpn).toBe('ATMEGA328-AU');
  });

  it('flags a row with no MPN column value as MISSING_MPN', () => {
    const md = `${header}\n| R2 | 4k7 | Resistor_SMD:R_0603_1608Metric | | |\n`;
    const rows = parseBomTable(md);
    expect(rows[0]!.flags).toEqual(['MISSING_MPN']);
    expect(rows[0]!.mpn).toBeUndefined();
  });

  it('drops rows with no refdes rather than throwing', () => {
    const md = `${header}\n|  | 10k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | |\n| R1 | 10k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | |\n`;
    const rows = parseBomTable(md);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.refdes).toBe('R1');
  });

  it('handles a short/ragged row without throwing', () => {
    const md = `${header}\n| R3 | 1k |\n`;
    expect(() => parseBomTable(md)).not.toThrow();
    const rows = parseBomTable(md);
    expect(rows[0]).toEqual({
      refdes: 'R3',
      value: '1k',
      footprint: undefined,
      mpn: undefined,
      flags: ['MISSING_MPN'],
    });
  });

  it('returns an empty array for a BOM with header only, no data rows', () => {
    expect(parseBomTable(header)).toEqual([]);
  });
});