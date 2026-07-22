/**
 * Shared markdown-table parsing for BOM.md and PINOUT.md (design D9's
 * fixed-column contract). Originally lived inline in drift.ts; pulled out so
 * the supplier BOM export work (add-supplier-bom-export) can parse BOM.md
 * once, the same way, instead of duplicating this.
 */

export interface TableRow {
    cells: string[];
  }
  
  /**
   * Parses every markdown pipe-table row out of a document, across however
   * many tables the file contains, skipping separator rows (e.g. `|---|---|`).
   * Malformed lines (stray `|` outside a real table) just become a row with
   * whatever cells they split into — this function never throws.
   */
  export function parseMarkdownTables(md: string): TableRow[] {
    const rows: TableRow[] = [];
    for (const line of md.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('|')) continue;
      const cells = t
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim());
      if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // separator row
      rows.push({ cells });
    }
    return rows;
  }
  
  /** True for a table's header row. BOM.md and PINOUT.md both lead with a
   * Refdes or Pin column, so one check covers both doc types. */
  export const isHeader = (row: TableRow): boolean =>
    row.cells.some((c) => /^(refdes|pin)$/i.test(c));
  
  /**
   * A typed BOM.md data row, per the fixed column contract that `init` writes
   * (Refdes | Value | Footprint | MPN | Rationale — see scaffold.ts's
   * `bomTable`). `flags` currently only ever contains `UNVERIFIED` (the MPN
   * column literally says so) or `MISSING_MPN` (no MPN column value at all);
   * more may be added as the export/fab-gate work grows.
   */
  export interface BomRow {
    refdes: string;
    value?: string;
    footprint?: string;
    mpn?: string;
    flags: string[];
  }
  
  /**
   * Parses BOM.md's data rows into typed rows. Rows without a refdes in
   * column 1 are dropped rather than thrown on: a hand-edited doc with a
   * ragged or partial table shouldn't crash `check` or `export bom`, it
   * should just be skipped (drift/export callers report the gaps that
   * matter through their own comparisons against the schematic).
   */
  export function parseBomTable(md: string): BomRow[] {
    const rows = parseMarkdownTables(md).filter((r) => !isHeader(r));
    const out: BomRow[] = [];
    for (const row of rows) {
      const [refdes, value, footprint, mpn] = row.cells;
      if (!refdes) continue;
      const flags: string[] = [];
      if (mpn === 'UNVERIFIED') flags.push('UNVERIFIED');
      else if (!mpn) flags.push('MISSING_MPN');
      out.push({
        refdes,
        value: value || undefined,
        footprint: footprint || undefined,
        mpn: mpn || undefined,
        flags,
      });
    }
    return out;
  }