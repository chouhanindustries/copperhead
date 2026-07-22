import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { listSymbols, pinNets, type SchematicSymbol } from '../kicad/sexp.js';
import { parseMarkdownTables, isHeader } from './bom-table.js';

/**
 * Doc-vs-schematic drift check (AC-2.3). BOM.md and PINOUT.md use fixed table
 * columns (the parseable contract, design D9); free-prose docs are not checked.
 */
export interface DriftMismatch {
  doc: string;
  claim: string;
  actual: string;
}

/**
 * The zero-symbol carve-out in checkDrift is right for the create pipeline,
 * but it would let `check` silently pass an established repo whose schematic
 * was emptied by accident while BOM.md still lists parts. `check` calls this
 * alongside checkDrift and reports the result as a warning, not a failure:
 * an empty sheet with a populated BOM is either bootstrap (fine) or an
 * accident (worth a human look), and only a human can tell which.
 */
export async function emptySchematicWarning(
  repoRoot: string,
  docsDir: string,
  schematic: string,
): Promise<string | null> {
  const symbols = await listSymbols(path.join(repoRoot, schematic));
  if (symbols.length) return null;
  const bomPath = path.join(repoRoot, docsDir, 'BOM.md');
  if (!existsSync(bomPath)) return null;
  const refs = parseMarkdownTables(await readFile(bomPath, 'utf8'))
    .filter((r) => !isHeader(r))
    .map((r) => r.cells[0])
    .filter(Boolean);
  if (!refs.length) return null;
  return `schematic has zero symbols but BOM.md lists ${refs.length} refdes; if this repo is not mid-bootstrap, the schematic may have been emptied accidentally`;
}

export async function checkDrift(repoRoot: string, docsDir: string, schematic: string): Promise<DriftMismatch[]> {
  const mismatches: DriftMismatch[] = [];
  const schPath = path.join(repoRoot, schematic);
  const symbols = await listSymbols(schPath);
  // A schematic with zero symbols is the bootstrap state: during the create
  // pipeline the docs legitimately lead the schematic (part-selection writes
  // BOM.md before any symbol exists), so comparing against an empty sheet
  // deadlocks every docs-touching stage — or worse, teaches the agent to strip
  // refdes from BOM.md to appease the gate (#21). Same reasoning as the
  // "no schematic configured" carve-out in the check_drift tool.
  if (!symbols.length) return mismatches;
  const byRef = new Map<string, SchematicSymbol>(symbols.map((s) => [s.ref, s]));

  const bomPath = path.join(repoRoot, docsDir, 'BOM.md');
  if (existsSync(bomPath)) {
    const rows = parseMarkdownTables(await readFile(bomPath, 'utf8')).filter((r) => !isHeader(r));
    const seen = new Set<string>();
    for (const row of rows) {
      const [ref, value, footprint] = row.cells;
      if (!ref) continue;
      seen.add(ref);
      const sym = byRef.get(ref);
      if (!sym) {
        mismatches.push({ doc: 'BOM.md', claim: `${ref} exists`, actual: `${ref} not in schematic` });
        continue;
      }
      if (value !== undefined && value !== sym.value) {
        mismatches.push({ doc: 'BOM.md', claim: `${ref} value ${value}`, actual: `${ref} value ${sym.value}` });
      }
      if (footprint !== undefined && footprint !== '' && footprint !== sym.footprint) {
        mismatches.push({
          doc: 'BOM.md',
          claim: `${ref} footprint ${footprint}`,
          actual: `${ref} footprint ${sym.footprint}`,
        });
      }
    }
    for (const sym of symbols) {
      if (!seen.has(sym.ref)) {
        mismatches.push({ doc: 'BOM.md', claim: `${sym.ref} absent`, actual: `${sym.ref} (${sym.value}) in schematic` });
      }
    }
  }

  const pinoutPath = path.join(repoRoot, docsDir, 'PINOUT.md');
  if (existsSync(pinoutPath)) {
    const nets = await pinNets(schPath);
    const netOf = new Map(nets.map((p) => [`${p.ref}:${p.pinNumber}`, p.net]));
    const rows = parseMarkdownTables(await readFile(pinoutPath, 'utf8')).filter((r) => !isHeader(r));
    for (const row of rows) {
      const [ref, pinNumber, , net] = row.cells;
      if (!ref || !pinNumber) continue;
      const k = `${ref}:${pinNumber}`;
      if (!netOf.has(k)) {
        mismatches.push({ doc: 'PINOUT.md', claim: `${k} exists`, actual: `${k} not in schematic` });
        continue;
      }
      const actual = netOf.get(k) ?? 'NC';
      const claimed = net === undefined || net === '' ? 'NC' : net;
      if (claimed !== actual) {
        mismatches.push({ doc: 'PINOUT.md', claim: `${k} net ${claimed}`, actual: `${k} net ${actual}` });
      }
    }
  }

  return mismatches;
}
