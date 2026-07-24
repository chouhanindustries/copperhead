export interface ViolationItem {
  description: string;
  x?: number;
  y?: number;
}

export interface Violation {
  severity: 'error' | 'warning' | string;
  type: string;
  description: string;
  sheet?: string;
  items: ViolationItem[];
}

export interface CheckReport {
  ok: boolean;
  source: 'erc' | 'drc';
  violations: Violation[];
}

interface RawItem {
  description?: string;
  pos?: { x?: number; y?: number };
}

interface RawViolation {
  severity?: string;
  type?: string;
  description?: string;
  items?: RawItem[];
}

function normViolation(v: RawViolation, sheet?: string): Violation {
  return {
    severity: v.severity ?? 'error',
    type: v.type ?? 'unknown',
    description: v.description ?? '',
    ...(sheet !== undefined ? { sheet } : {}),
    items: (v.items ?? []).map((i) => ({
      description: i.description ?? '',
      ...(i.pos?.x !== undefined ? { x: i.pos.x } : {}),
      ...(i.pos?.y !== undefined ? { y: i.pos.y } : {}),
    })),
  };
}

/**
 * Normalize kicad-cli ERC and DRC JSON reports into one shape. ERC nests
 * violations per sheet; DRC has top-level `violations` plus `unconnected_items`
 * and `schematic_parity`. Tolerant of missing fields across KiCad versions.
 */
export function normalizeReport(raw: unknown, source: 'erc' | 'drc'): CheckReport {
  const r = raw as {
    sheets?: { path?: string; violations?: RawViolation[] }[];
    violations?: RawViolation[];
    unconnected_items?: RawViolation[];
    schematic_parity?: RawViolation[];
  };
  const violations: Violation[] = [];
  for (const sheet of r.sheets ?? []) {
    for (const v of sheet.violations ?? []) violations.push(normViolation(v, sheet.path));
  }
  for (const v of r.violations ?? []) violations.push(normViolation(v));
  for (const v of r.unconnected_items ?? []) violations.push(normViolation(v));
  for (const v of r.schematic_parity ?? []) violations.push(normViolation(v));
  // Severity-aware gate: kicad-cli reports carry warning-level entries
  // (exclusions, advisory checks) alongside errors. Only error severity blocks;
  // an entry with no severity field is treated as an error for safety.
  // Warnings stay in the list so callers can still surface them.
  const blocking = violations.filter((v) => v.severity !== 'warning');
  return { ok: blocking.length === 0, source, violations };
}

export function formatViolations(report: CheckReport): string {
  if (report.ok) return `${report.source.toUpperCase()}: clean`;
  const lines = [`${report.source.toUpperCase()}: ${report.violations.length} violation(s)`];
  for (const v of report.violations) {
    const where = v.sheet ? ` [sheet ${v.sheet}]` : '';
    lines.push(`  ${v.severity} ${v.type}${where}: ${v.description}`);
    for (const i of v.items) {
      const pos = i.x !== undefined ? ` @ (${i.x}, ${i.y})` : '';
      lines.push(`    - ${i.description}${pos}`);
    }
  }
  return lines.join('\n');
}
