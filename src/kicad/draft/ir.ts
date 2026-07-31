import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { SymbolSource, SymbolResolutionError, type ResolvedSymbol } from './symsource.js';

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

/** BOM.md rows as { ref, value }, or null when the file/table is absent. */
async function bomRowsOf(file: string): Promise<{ ref: string; value: string }[] | null> {
  if (!existsSync(file)) return null;
  const text = await readFile(file, 'utf8');
  const rows: { ref: string; value: string }[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|') || line.includes('---')) continue;
    const cols = line.split('|').map((c) => c.trim());
    const ref = cols[1] ?? '';
    if (!ref || ref.toLowerCase() === 'refdes') continue;
    rows.push({ ref, value: cols[2] ?? '' });
  }
  return rows.length ? rows : null;
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
      if (bomValue === undefined) add(`${p.ref} is not a BOM.md row; add it to the BOM or drop it from the intent`);
      else if (bomValue !== p.value) add(`${p.ref} value "${p.value}" differs from BOM.md's "${bomValue}"`);
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