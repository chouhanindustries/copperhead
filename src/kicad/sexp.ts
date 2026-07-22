import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Minimal READ-ONLY s-expression tooling for .kicad_sch files. This module
 * never serializes: edits to KiCad files happen as anchored text replaces on
 * the original source (SPEC §1.3 / design D4).
 */

export type SexpNode = string | SexpNode[];

export function parseSexp(text: string): SexpNode[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '(' || c === ')') {
      tokens.push(c);
      i++;
    } else if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length) {
          s += text[j + 1];
          j += 2;
        } else {
          s += text[j];
          j++;
        }
      }
      tokens.push(JSON.stringify(s));
      i = j + 1;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      let j = i;
      while (j < text.length && !/[\s()"]/.test(text[j]!)) j++;
      tokens.push(text.slice(i, j));
      i = j;
    }
  }
  let pos = 0;
  function parseNode(): SexpNode {
    const tok = tokens[pos++]!;
    if (tok === '(') {
      const list: SexpNode[] = [];
      while (pos < tokens.length && tokens[pos] !== ')') list.push(parseNode());
      pos++; // consume ')'
      return list;
    }
    return tok.startsWith('"') ? (JSON.parse(tok) as string) : tok;
  }
  const roots: SexpNode[] = [];
  while (pos < tokens.length) roots.push(parseNode());
  return roots;
}

export const isList = (n: SexpNode): n is SexpNode[] => Array.isArray(n);
const tag = (n: SexpNode): string | null => (isList(n) && typeof n[0] === 'string' ? n[0] : null);

export function children(node: SexpNode, name: string): SexpNode[][] {
  if (!isList(node)) return [];
  return node.filter((c): c is SexpNode[] => tag(c) === name);
}

export function child(node: SexpNode, name: string): SexpNode[] | undefined {
  return children(node, name)[0];
}

function atomAt(node: SexpNode[] | undefined, idx: number): string | undefined {
  const v = node?.[idx];
  return typeof v === 'string' ? v : undefined;
}

function property(sym: SexpNode[], key: string): string | undefined {
  for (const p of children(sym, 'property')) {
    if (atomAt(p, 1) === key) return atomAt(p, 2);
  }
  return undefined;
}

export interface SchematicSymbol {
  ref: string;
  value: string;
  footprint: string;
  libId: string;
  sheet: string;
  at: { x: number; y: number; rot: number };
  uuid: string;
}

export interface PinDef {
  number: string;
  name: string;
  x: number;
  y: number;
}

interface ParsedSheet {
  filePath: string;
  sheetName: string;
  root: SexpNode[];
}

export interface BoardFootprint {
  ref: string;
  footprint: string;
  at: { x: number; y: number; rot: number };
  side: 'front' | 'back' | 'unknown';
}

async function loadSheets(rootSch: string): Promise<ParsedSheet[]> {
  const seen = new Set<string>();
  const out: ParsedSheet[] = [];
  async function load(file: string, sheetName: string): Promise<void> {
    const abs = path.resolve(file);
    if (seen.has(abs)) return;
    seen.add(abs);
    const text = await readFile(abs, 'utf8');
    const root = parseSexp(text)[0];
    if (root === undefined || !isList(root)) {
      throw new Error(`not a KiCad s-expression file: ${file}`);
    }
    out.push({ filePath: abs, sheetName, root });
    for (const sheet of children(root, 'sheet')) {
      const sub = property(sheet, 'Sheetfile') ?? property(sheet, 'Sheet file');
      const name = property(sheet, 'Sheetname') ?? property(sheet, 'Sheet name') ?? 'sheet';
      if (sub) await load(path.resolve(path.dirname(abs), sub), name);
    }
  }
  await load(rootSch, '/');
  return out;
}

/** Pin definitions per lib symbol name, in symbol coordinates. */
function libPinDefs(root: SexpNode[]): Map<string, PinDef[]> {
  const map = new Map<string, PinDef[]>();
  const libs = child(root, 'lib_symbols');
  if (!libs) return map;
  for (const sym of children(libs, 'symbol')) {
    const name = atomAt(sym, 1);
    if (!name) continue;
    const pins: PinDef[] = [];
    const walk = (n: SexpNode): void => {
      if (!isList(n)) return;
      if (tag(n) === 'pin') {
        const at = child(n, 'at');
        const num = atomAt(child(n, 'number'), 1);
        const pinName = atomAt(child(n, 'name'), 1);
        if (at && num !== undefined) {
          pins.push({
            number: num,
            name: pinName ?? '~',
            x: parseFloat(atomAt(at, 1) ?? '0'),
            y: parseFloat(atomAt(at, 2) ?? '0'),
          });
        }
      }
      for (const c of n) walk(c);
    };
    walk(sym);
    map.set(name, pins);
  }
  return map;
}

/** Symbol-space → schematic-space transform (schematic Y grows downward). */
export function pinAbsolute(
  symAt: { x: number; y: number; rot: number },
  mirror: 'x' | 'y' | null,
  pin: { x: number; y: number },
): { x: number; y: number } {
  let px = pin.x;
  let py = pin.y;
  if (mirror === 'y') px = -px;
  if (mirror === 'x') py = -py;
  const theta = (symAt.rot * Math.PI) / 180;
  const rx = px * Math.cos(theta) - py * Math.sin(theta);
  const ry = px * Math.sin(theta) + py * Math.cos(theta);
  return { x: round(symAt.x + rx), y: round(symAt.y - ry) };
}

const round = (n: number): number => Math.round(n * 10000) / 10000;
const key = (x: number, y: number): string => `${round(x)},${round(y)}`;

class UnionFind {
  private parent = new Map<string, string>();
  find(k: string): string {
    let p = this.parent.get(k);
    if (p === undefined) {
      this.parent.set(k, k);
      return k;
    }
    if (p !== k) {
      p = this.find(p);
      this.parent.set(k, p);
    }
    return p;
  }
  union(a: string, b: string): void {
    this.parent.set(this.find(a), this.find(b));
  }
}

function symbolsOf(sheet: ParsedSheet): { node: SexpNode[]; sym: SchematicSymbol; mirror: 'x' | 'y' | null }[] {
  const out: { node: SexpNode[]; sym: SchematicSymbol; mirror: 'x' | 'y' | null }[] = [];
  for (const s of children(sheet.root, 'symbol')) {
    const libId = atomAt(child(s, 'lib_id'), 1);
    if (!libId) continue; // lib_symbols entries have no lib_id child
    const at = child(s, 'at');
    const mirrorAtom = atomAt(child(s, 'mirror'), 1);
    out.push({
      node: s,
      mirror: mirrorAtom === 'x' || mirrorAtom === 'y' ? mirrorAtom : null,
      sym: {
        ref: property(s, 'Reference') ?? '?',
        value: property(s, 'Value') ?? '',
        footprint: property(s, 'Footprint') ?? '',
        libId,
        sheet: sheet.sheetName,
        at: {
          x: parseFloat(atomAt(at, 1) ?? '0'),
          y: parseFloat(atomAt(at, 2) ?? '0'),
          rot: parseFloat(atomAt(at, 3) ?? '0'),
        },
        uuid: atomAt(child(s, 'uuid'), 1) ?? '',
      },
    });
  }
  return out;
}

const isPowerSymbol = (libId: string): boolean => libId.startsWith('power:');

/** One row per real component (power symbols excluded), across all sheets. */
export async function listSymbols(rootSch: string): Promise<SchematicSymbol[]> {
  const sheets = await loadSheets(rootSch);
  const out: SchematicSymbol[] = [];
  for (const sheet of sheets) {
    for (const { sym } of symbolsOf(sheet)) {
      if (!isPowerSymbol(sym.libId)) out.push(sym);
    }
  }
  return out.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
}
/** Reads a KiCad PCB file and returns each placed footprint's reference, footprint name, and placement information. */
export async function listFootprints(boardPath: string): Promise<BoardFootprint[]> {
  const text = await readFile(boardPath, 'utf8');
  const root = parseSexp(text)[0];
  if (root === undefined || !isList(root)) {
    throw new Error(`not a KiCad s-expression file: ${boardPath}`);
  }
  const footprints: BoardFootprint[] = [];

  for (const footprintNode of children(root, 'footprint')) {
    const footprintId = atomAt(footprintNode, 1) ?? '';
    const ref = property(footprintNode, 'Reference') ?? '?';
    const at = child(footprintNode, 'at');
    const layer = atomAt(child(footprintNode, 'layer'), 1);
    let side: BoardFootprint['side'] = 'unknown';
    if (layer === 'F.Cu') side = 'front';
    if (layer === 'B.Cu') side = 'back';
    footprints.push({
      ref,
      footprint: footprintId,
      at: {
        x: parseFloat(atomAt(at, 1) ?? '0'),
        y: parseFloat(atomAt(at, 2) ?? '0'),
        rot: parseFloat(atomAt(at, 3) ?? '0'),
      },
      side,
    });
  }
  return footprints.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
}

/** All net names visible via labels and power symbols, across all sheets. */
export async function listNets(rootSch: string): Promise<string[]> {
  const sheets = await loadSheets(rootSch);
  const names = new Set<string>();
  for (const sheet of sheets) {
    for (const kind of ['label', 'global_label', 'hierarchical_label']) {
      for (const l of children(sheet.root, kind)) {
        const name = atomAt(l, 1);
        if (name) names.add(name);
      }
    }
    for (const { sym } of symbolsOf(sheet)) {
      if (isPowerSymbol(sym.libId)) names.add(sym.value);
    }
  }
  return [...names].sort();
}

export interface PinNet {
  ref: string;
  pinNumber: string;
  pinName: string;
  net: string | null;
}

/**
 * Geometric connectivity per sheet: pins, labels, and wire endpoints that share
 * coordinates (or are joined by wires) form a group; a group's net name comes
 * from its labels or power symbols. Good enough for docs scaffolding and drift
 * checks; not a full netlister.
 */
export async function pinNets(rootSch: string): Promise<PinNet[]> {
  const sheets = await loadSheets(rootSch);
  const out: PinNet[] = [];
  for (const sheet of sheets) {
    const pinDefs = libPinDefs(sheet.root);
    const uf = new UnionFind();
    const netNameAt = new Map<string, string>();

    for (const w of children(sheet.root, 'wire')) {
      const pts = children(child(w, 'pts') ?? [], 'xy').map((xy) => ({
        x: parseFloat(atomAt(xy, 1) ?? '0'),
        y: parseFloat(atomAt(xy, 2) ?? '0'),
      }));
      for (let i = 1; i < pts.length; i++) {
        uf.union(key(pts[0]!.x, pts[0]!.y), key(pts[i]!.x, pts[i]!.y));
      }
    }
    for (const kind of ['label', 'global_label', 'hierarchical_label']) {
      for (const l of children(sheet.root, kind)) {
        const name = atomAt(l, 1);
        const at = child(l, 'at');
        if (!name || !at) continue;
        const k = key(parseFloat(atomAt(at, 1) ?? '0'), parseFloat(atomAt(at, 2) ?? '0'));
        uf.find(k);
        netNameAt.set(k, name);
      }
    }

    const symPins: { sym: SchematicSymbol; pin: PinDef; k: string }[] = [];
    for (const { sym, mirror } of symbolsOf(sheet)) {
      const defs = pinDefs.get(sym.libId) ?? [];
      for (const pin of defs) {
        const abs = pinAbsolute(sym.at, mirror, pin);
        const k = key(abs.x, abs.y);
        uf.find(k);
        if (isPowerSymbol(sym.libId)) {
          netNameAt.set(k, sym.value);
        } else {
          symPins.push({ sym, pin, k });
        }
      }
    }

    const groupNet = new Map<string, string>();
    for (const [k, name] of netNameAt) groupNet.set(uf.find(k), name);
    for (const { sym, pin, k } of symPins) {
      out.push({
        ref: sym.ref,
        pinNumber: pin.number,
        pinName: pin.name,
        net: groupNet.get(uf.find(k)) ?? null,
      });
    }
  }
  return out;
}
