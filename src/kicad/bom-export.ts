/** A row from the normalized BOM representation used by supplier emitters. */
export interface NormalizedBomRow {
  refdes: string;
  value: string;
  footprint: string;
  mpn?: string | null;
  lcsc?: string | null;
  /** Verification marker from BOM.md (for example, `UNVERIFIED`). */
  status?: string | null;
  /** Alias accepted while the shared parser is being introduced. */
  verification?: string | null;
  /** Quantity belongs to other supplier formats and is intentionally ignored here. */
  quantity?: number;
  [key: string]: unknown;
}

export interface JlcpcbBomOptions {
  includeUnverified?: boolean;
  /** Include diagnostic comment lines in the CSV when the target accepts them. */
  includeWarningsInCsv?: boolean;
}

export interface BomExportWarning {
  refdes: string;
  reason: string;
  message: string;
}

export interface JlcpcbBomResult {
  csv: string;
  warnings: BomExportWarning[];
}

const HEADER = ['Comment', 'Designator', 'Footprint', 'LCSC Part #'];

/**
 * Emit the four-column JLCPCB assembly BOM format.
 *
 * Rows are grouped only when value, footprint, and LCSC part number all match.
 * MPN is used for eligibility, but is not part of the JLCPCB file.
 */
export function emitJlcpcbBom(
  rows: readonly NormalizedBomRow[],
  options: JlcpcbBomOptions = {},
): JlcpcbBomResult {
  const warnings: BomExportWarning[] = [];
  const groups = new Map<string, NormalizedBomRow[]>();

  for (const row of rows) {
    const refdes = row.refdes.trim();
    const mpn = row.mpn?.trim() ?? '';
    const mpnIsUnverifiedMarker = mpn.toUpperCase() === 'UNVERIFIED';
    if (!mpn || mpnIsUnverifiedMarker) {
      warnings.push(warning(refdes, mpnIsUnverifiedMarker ? 'invalid MPN (UNVERIFIED marker)' : 'missing MPN'));
      continue;
    }

    const verification = (row.status || row.verification || '').trim().toUpperCase();
    if (verification === 'UNVERIFIED') {
      warnings.push(warning(refdes, 'UNVERIFIED (use includeUnverified to include)'));
      if (!options.includeUnverified) continue;
    }

    const key = JSON.stringify([row.value.trim(), row.footprint.trim(), row.lcsc?.trim() ?? '']);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const outputRows = [...groups.values()]
    .sort((a, b) => compareRefdes(firstRefdes(a), firstRefdes(b)))
    .map((group) => {
      const first = group[0]!;
      return [
        first.value.trim(),
        [...new Set(group.map((row) => row.refdes.trim()).filter(Boolean))].sort(compareRefdes).join(','),
        first.footprint.trim(),
        first.lcsc?.trim() ?? '',
      ];
    });

  const lines = [HEADER.join(','), ...outputRows.map(csvLine)];
  if (options.includeWarningsInCsv) {
    lines.push(...warnings.map((item) => `# ${item.message}`));
  }
  return { csv: `${lines.join('\n')}\n`, warnings };
}

function firstRefdes(group: readonly NormalizedBomRow[]): string {
  return [...group].map((row) => row.refdes.trim()).sort(compareRefdes)[0] ?? '';
}

function warning(refdes: string, reason: string): BomExportWarning {
  const name = refdes || '<unnamed row>';
  return { refdes, reason, message: `Excluded ${name}: ${reason}` };
}

function csvLine(fields: readonly string[]): string {
  return fields.map((field) => `"${field.replaceAll('"', '""')}"`).join(',');
}

/** Natural ordering for references: R2 before R10, and C2 before R1. */
function compareRefdes(left: string, right: string): number {
  const a = tokenizeRefdes(left);
  const b = tokenizeRefdes(right);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const leftToken = a[i];
    const rightToken = b[i];
    if (leftToken === undefined) return -1;
    if (rightToken === undefined) return 1;
    const result = typeof leftToken === 'number' && typeof rightToken === 'number'
      ? leftToken - rightToken
      : String(leftToken).localeCompare(String(rightToken));
    if (result !== 0) return result;
  }
  return left.localeCompare(right);
}

function tokenizeRefdes(refdes: string): (string | number)[] {
  return refdes.trim().match(/\d+|\D+/g)?.map((part) => /^\d+$/.test(part) ? Number(part) : part) ?? [refdes];
}
