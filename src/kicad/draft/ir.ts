import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { SymbolSource, SymbolResolutionError, type ResolvedSymbol } from './symsource.js';
import { parseBomTable, normalizeValue } from '../../memory/bom-table.js';

/**
 * The netlist-intent IR (`schematic.intent.json`): the compact declarative
 * input the model authors instead of geometry (design D5/D6). No coordinates,
 * ever — the engine computes every position. Re-drafting the same IR fully
 * regenerates the sheet.
 */

export const INTENT_VERSION = 1;
export const INTENT_FILENAME = 'schematic.intent.json';

export interface IntentPart {
  ref: string;
  libId: string;
  value: string;
  footprint?: string;
  /** Subsystem group (from SUBSYSTEMS.md); required for every non-power part. */
  group: string;
}

export interface IntentNet {
  name: string;
  /** Endpoints as `"REF.PIN"` (pin number). */
  pins: string[];
  /** Optional class override; wins over pin-type inference (engine spec). */
  kind?: 'power' | 'ground' | 'signal';
}

export interface SchematicIntent {
  version: number;
  parts: IntentPart[];
  nets: IntentNet[];
  /** Pins deliberately unconnected; emitted as `(no_connect …)` markers. */
  noConnect?: string[];
  hints?: {
    /** Left-to-right group order override; otherwise SUBSYSTEMS.md order. */
    groupOrder?: string[];
    /** Pin the paper size instead of deriving it from content. */
    paper?: string;
    /** Title-block date. Part of the IR (not the wall clock) so identical IR
     * emits identical bytes on any day (design D4). */
    date?: string;
  };
}

export interface IrFinding {
  detail: string;
}

export interface ValidatedIntent {
  intent: SchematicIntent;
  symbols: Map<string, ResolvedSymbol>;
  /** SUBSYSTEMS.md heading names in declaration order, or null when absent. */
  docGroups: string[] | null;
}

/** `## Heading` names from a markdown file, in order. */
async function headingsOf(file: string): Promise<string[] | null> {
  if (!existsSync(file)) return null;
  const text = await readFile(file, 'utf8');
  const names = [...text.matchAll(/^#{2,6}\s+(.+?)\s*$/gm)].map((m) => m[1]!.trim()).filter(Boolean);
  return names.length ? names : null;
}

/**
 * BOM.md rows as { ref, value }, or null when the file/table is absent.
 *
 * Goes through the shared canonical reader (`parseBomTable`) rather than
 * scanning every pipe-line in the file: the old inline scan read a supporting
 * table's rows (a quiescent-current roll-up, a cost summary) as parts.
 * `parseBomTable` reads only the Refdes-headed canonical table(s) and resolves
 * Value by header *name*, the same discipline `checkDrift` and `export bom`
 * already use.
 *
 * One row per refdes: a cell naming several parts (`R1, R2`, `C5-C8`) is read
 * verbatim and simply matches nothing, because the BOM contract is one row per
 * part — the row's single Rationale cell is where that part's purpose lives.
 */
async function bomRowsOf(file: string): Promise<{ ref: string; value: string }[] | null> {
  if (!existsSync(file)) return null;
  const rows = parseBomTable(await readFile(file, 'utf8')).map((r) => ({ ref: r.refdes, value: r.value ?? '' }));
  return rows.length ? rows : null;
}

/**
 * Is this BOM Value cell a component *value*, or a description?
 *
 * The Value cell is drawn on the sheet as the symbol's Value field, so its
 * length is a layout input, not just documentation. A cell like
 * `1S Li-Po cell, 500 mAh, bare leads` renders as 34 characters beside a
 * battery symbol and collides with its neighbours — an error-severity
 * legibility finding that `create`'s stage-4 contract refuses to pass.
 *
 * That is unrecoverable without this check. The IR is the agent's only lever
 * on the drawn sheet (`edit_file` is refused on a drafted schematic), and the
 * BOM cross-check below pins the IR value to this cell — so shortening the
 * value in the IR fails validation, and leaving it fails legibility. The run
 * that found this burned all three stage-4 attempts and 2h49m discovering the
 * loop, twice, because the legibility findings never named BOM.md as the thing
 * to change (see the deadlock issue).
 *
 * Heuristic, deliberately loose — it fires only on cells that are clearly
 * prose, so a legitimately long value (`STM32F103C8T6`,
 * `JST_PH_S2B-PH-K_1x02_P2.00mm`) is left alone:
 *  - a comma-separated clause list where a later clause contains a space
 *    (`4.7uF, X5R, 10V, 0603` is a value; `P-MOSFET, divider gate` is prose), or
 *  - a cell that is simply too long to draw (> MAX_DRAWN_VALUE chars).
 */
const MAX_DRAWN_VALUE = 24;

export function looksLikeDescription(value: string): boolean {
  const v = value.replace(/`/g, '').trim();
  if (!v) return false;
  if (v.length > MAX_DRAWN_VALUE) return true;
  const clauses = v.split(',').map((c) => c.trim());
  return clauses.length > 1 && clauses.slice(1).some((c) => c.includes(' ') && /[a-z]{3}/i.test(c));
}

export function parseIntent(json: string): { intent: SchematicIntent | null; findings: IrFinding[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { intent: null, findings: [{ detail: `intent is not valid JSON: ${(e as Error).message}` }] };
  }
  if (raw === null || typeof raw !== 'object') {
    return { intent: null, findings: [{ detail: 'intent must be a JSON object' }] };
  }
  const o = raw as Record<string, unknown>;
  if (o.version !== INTENT_VERSION) {
    return {
      intent: null,
      findings: [{ detail: `unsupported intent version ${JSON.stringify(o.version)}; this engine supports version ${INTENT_VERSION}` }],
    };
  }
  if (!Array.isArray(o.parts) || !Array.isArray(o.nets)) {
    return { intent: null, findings: [{ detail: 'intent needs "parts" and "nets" arrays' }] };
  }
  return { intent: raw as SchematicIntent, findings: [] };
}

/**
 * Validate the IR before any placement (design D6): structural checks, lib
 * resolution, pin existence, group membership against SUBSYSTEMS.md, no-connect
 * consistency, and the BOM.md cross-check. A failed validation means nothing is
 * written; findings come back numbered in the verify_symbols shape.
 */
export async function validateIntent(
  intent: SchematicIntent,
  symsource: SymbolSource,
  docsDir: string | null,
): Promise<{ ok: boolean; findings: IrFinding[]; validated: ValidatedIntent | null }> {
  const findings: IrFinding[] = [];
  const add = (detail: string): void => {
    findings.push({ detail });
  };

  // parts: shape, duplicates, lib resolution
  const symbols = new Map<string, ResolvedSymbol>();
  const partByRef = new Map<string, IntentPart>();
  for (const p of intent.parts) {
    if (!p?.ref || !p.libId || typeof p.value !== 'string') {
      add(`part ${JSON.stringify(p?.ref ?? '(missing ref)')} needs ref, libId, and value`);
      continue;
    }
    if (partByRef.has(p.ref)) {
      add(`duplicate refdes ${p.ref}`);
      continue;
    }
    partByRef.set(p.ref, p);
    try {
      symbols.set(p.ref, await symsource.resolve(p.libId));
    } catch (e) {
      if (e instanceof SymbolResolutionError) add(`${p.ref}: ${e.message}`);
      else throw e;
    }
  }

  // groups: exactly one per non-power part, validated against SUBSYSTEMS.md when present
  const docGroups = docsDir ? await headingsOf(path.join(docsDir, 'SUBSYSTEMS.md')) : null;
  for (const p of partByRef.values()) {
    const sym = symbols.get(p.ref);
    if (sym?.isPower) continue;
    if (!p.group) {
      add(`${p.ref} has no group assignment; available groups: ${docGroups?.join(', ') ?? '(SUBSYSTEMS.md absent)'}`);
    } else if (docGroups && !docGroups.some((g) => g.toLowerCase() === p.group.toLowerCase())) {
      add(`${p.ref} names group "${p.group}", which is not a SUBSYSTEMS.md heading; available: ${docGroups.join(', ')}`);
    }
  }

  // nets: endpoints exist, at least two of them
  const pinKey = (ref: string, pin: string): string => `${ref}.${pin}`;
  const usedPins = new Set<string>();
  const netNames = new Set<string>();
  for (const net of intent.nets) {
    if (!net?.name || !Array.isArray(net.pins)) {
      add(`net ${JSON.stringify(net?.name ?? '(unnamed)')} needs a name and a pins array`);
      continue;
    }
    if (netNames.has(net.name)) add(`duplicate net name ${net.name}`);
    netNames.add(net.name);
    if (net.pins.length < 2) add(`net ${net.name} has ${net.pins.length} endpoint(s); a net needs at least two`);
    for (const ep of net.pins) {
      const m = /^([^.]+)\.(.+)$/.exec(ep);
      if (!m) {
        add(`net ${net.name}: endpoint "${ep}" is not of the form REF.PIN`);
        continue;
      }
      const [, ref, pin] = m;
      const sym = symbols.get(ref!);
      if (!partByRef.has(ref!)) {
        add(`net ${net.name}: endpoint "${ep}" references unknown part ${ref}`);
        continue;
      }
      if (sym && !sym.pins.some((p) => p.number === pin)) {
        add(`net ${net.name}: ${ref} has no pin ${pin}; its pins are [${sym.pins.map((p) => p.number).join(', ')}]`);
      }
      if (usedPins.has(pinKey(ref!, pin!))) add(`pin ${ep} appears in more than one net`);
      usedPins.add(pinKey(ref!, pin!));
    }
  }

  // no-connects: pin exists and is not in any net
  for (const ep of intent.noConnect ?? []) {
    const m = /^([^.]+)\.(.+)$/.exec(ep);
    if (!m) {
      add(`noConnect entry "${ep}" is not of the form REF.PIN`);
      continue;
    }
    const [, ref, pin] = m;
    const sym = symbols.get(ref!);
    if (!partByRef.has(ref!)) add(`noConnect "${ep}" references unknown part ${ref}`);
    else if (sym && !sym.pins.some((p) => p.number === pin)) add(`noConnect "${ep}": ${ref} has no pin ${pin}`);
    if (usedPins.has(`${ref}.${pin}`)) add(`pin ${ep} is declared no-connect but appears in a net`);
  }

  // BOM cross-check: a transcription slip dies here, not at the drift gate (D6)
  const bomRows = docsDir ? await bomRowsOf(path.join(docsDir, 'BOM.md')) : null;
  if (bomRows) {
    const bomByRef = new Map(bomRows.map((r) => [r.ref, r.value]));
    for (const p of partByRef.values()) {
      if (symbols.get(p.ref)?.isPower) continue;
      const bomValue = bomByRef.get(p.ref);
      if (bomValue === undefined) {
        add(`${p.ref} is not a BOM.md row; add it to the BOM or drop it from the intent`);
        continue;
      }
      // Drawability first, and independently of whether the two agree. Whether
      // the cell can be drawn is a property of BOM.md alone, and the agent's
      // first instinct on an unreadable sheet is to shorten the value in the
      // intent — which makes the two differ. Reporting this only on a match
      // answers that instinct with "differs from BOM.md's …" and never names the
      // real problem, which is the loop this check exists to break: the fix is in
      // the doc, not the intent.
      if (looksLikeDescription(bomValue)) {
        add(
          `${p.ref}: BOM.md's Value is a description, not a component value ("${bomValue}"). ` +
            `It is drawn on the sheet as ${p.ref}'s Value field, where it collides with neighbouring symbols ` +
            `and fails the legibility gate — and you cannot shorten it in the intent alone, because this ` +
            `cross-check requires the two to agree. Fix docs/BOM.md: put the component value in the Value column ` +
            `(e.g. "500mAh Li-Po", "4.7uF", "1M") and move the prose to the Rationale column, then update the intent to match.`,
        );
        continue; // the value mismatch below would be noise next to this
      }
      // Compared through the shared value key, not raw bytes: `1 MΩ` vs `1 Mohm`
      // and `4.7uF` vs `4.7 µF` are encoding differences with no electrical
      // meaning. `checkDrift` has always folded them (normalizeValue); this gate
      // running stricter than the gate downstream of it meant an IR that would
      // pass drift could still be refused here, with no way to satisfy both.
      if (normalizeValue(bomValue) !== normalizeValue(p.value)) {
        add(`${p.ref} value "${p.value}" differs from BOM.md's "${bomValue}"`);
      }
    }
  }

  if (findings.length) return { ok: false, findings, validated: null };
  return { ok: true, findings: [], validated: { intent, symbols, docGroups } };
}

export function formatIrFindings(findings: IrFinding[]): string {
  return [
    `intent validation: ${findings.length} finding(s) to reconcile:`,
    ...findings.map((f, i) => `  ${i + 1}. ${f.detail}`),
  ].join('\n');
}