import { readFile } from 'node:fs/promises';
import { parseSexp, children, child, isList, type SexpNode } from './sexp.js';

/**
 * Minimal READ-ONLY `.kicad_pcb` reader, built on the same s-expression tooling
 * as the schematic side. Like that module it never serializes: board edits are
 * anchored exact-match text replaces on the original source (SPEC §1.3 / design
 * D4). Everything here extracts geometry for measurement only.
 *
 * Net identity spans two file generations and both are resolved to a name:
 *
 * - KiCad 8/9 writes `(net 3 "GND")` on pads, bare `(net 3)` on segments and
 *   zones, and a top-level `(net 3 "GND")` table.
 * - KiCad 10 writes `(net "GND")` everywhere and keeps the table for id 0 only.
 */

export interface Extents {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface BoardPad {
  /** Reference designator of the footprint that owns this pad. */
  ref: string;
  number: string;
  net: string | null;
  /** Absolute board position, after applying the footprint rotation. */
  x: number;
  y: number;
  /** Pad size as written, before rotation. */
  width: number;
  height: number;
  /** Copper layers this pad lands on, wildcards expanded. */
  layers: string[];
  /** Largest pad dimension, used as the pad-to-track snap tolerance. */
  extent: number;
  type: string;
}

export interface BoardFootprint {
  ref: string;
  value: string;
  libId: string;
  layer: string;
  x: number;
  y: number;
  rot: number;
  pads: BoardPad[];
  /** Absolute courtyard extents from F.CrtYd / B.CrtYd graphics, when drawn. */
  courtyard: Extents | null;
}

export interface TrackSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  layer: string;
  net: string | null;
}

export interface BoardVia {
  x: number;
  y: number;
  size: number;
  drill: number;
  layers: string[];
  net: string | null;
}

export interface BoardZone {
  net: string | null;
  layers: string[];
  /** Area of the filled polygons, when the zone is filled. */
  filledAreaMm2: number;
}

export interface Board {
  filePath: string;
  generatorVersion: string | null;
  copperLayers: string[];
  /** Every net name on the board: the net table plus every net resolved on a
   *  pad, segment, via or zone. KiCad 10 keeps the table for net 0 only, so
   *  the table alone would read as empty there. */
  netNames: string[];
  footprints: BoardFootprint[];
  segments: TrackSegment[];
  vias: BoardVia[];
  zones: BoardZone[];
  /** Extents of the Edge.Cuts graphics, or null when the board has no outline. */
  outline: Extents | null;
}

const atom = (node: SexpNode[] | undefined, i: number): string | undefined => {
  const v = node?.[i];
  return typeof v === 'string' ? v : undefined;
};

const num = (node: SexpNode[] | undefined, i: number, fallback = 0): number => {
  const v = parseFloat(atom(node, i) ?? '');
  return Number.isFinite(v) ? v : fallback;
};

function propertyValue(node: SexpNode[], key: string): string | undefined {
  for (const p of children(node, 'property')) {
    if (atom(p, 1) === key) return atom(p, 2);
  }
  return undefined;
}

/**
 * Footprint-local → board coordinates. KiCad rotates footprint children with
 * `RotatePoint`, whose sense is x' = x·cos + y·sin, y' = -x·sin + y·cos (the
 * board's Y axis grows downward). Calibrated against the installed demos: this
 * convention lands measurably more pads on real track endpoints than its
 * mirror on every demo checked.
 */
export function footprintLocalToBoard(
  origin: { x: number; y: number; rot: number },
  local: { x: number; y: number },
): { x: number; y: number } {
  const theta = (origin.rot * Math.PI) / 180;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return {
    x: round(origin.x + local.x * c + local.y * s),
    y: round(origin.y - local.x * s + local.y * c),
  };
}

const round = (n: number): number => {
  // `|| 0` folds the -0 that trigonometry produces at 90/180 degrees back to 0,
  // so coordinates compare and serialize the way a reader expects.
  const r = Math.round(n * 1e6) / 1e6;
  return r || 0;
};

function extendExtents(ext: Extents | null, x: number, y: number): Extents {
  if (!ext) return { minX: x, minY: y, maxX: x, maxY: y };
  return {
    minX: Math.min(ext.minX, x),
    minY: Math.min(ext.minY, y),
    maxX: Math.max(ext.maxX, x),
    maxY: Math.max(ext.maxY, y),
  };
}

export const extentsWidth = (e: Extents): number => e.maxX - e.minX;
export const extentsHeight = (e: Extents): number => e.maxY - e.minY;
export const extentsArea = (e: Extents): number => extentsWidth(e) * extentsHeight(e);

export function extentsOverlap(a: Extents, b: Extents): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

/** Layer names a graphic/pad node declares, via `(layer "x")` or `(layers "a" "b")`. */
function layersOf(node: SexpNode[]): string[] {
  const single = child(node, 'layer');
  if (single) {
    const name = atom(single, 1);
    return name ? [name] : [];
  }
  const many = child(node, 'layers');
  if (!many) return [];
  return many.slice(1).filter((v): v is string => typeof v === 'string');
}

/** Expand `*.Cu` / `F&B.Cu` against the board's declared copper stack. */
function expandCopperLayers(declared: string[], copperLayers: string[]): string[] {
  const out = new Set<string>();
  for (const l of declared) {
    if (l === '*.Cu') for (const c of copperLayers) out.add(c);
    else if (l === 'F&B.Cu') {
      for (const c of ['F.Cu', 'B.Cu']) if (copperLayers.includes(c)) out.add(c);
    } else if (l.endsWith('.Cu')) out.add(l);
  }
  return [...out];
}

/** Every point a graphic node contributes to a bounding box, in its own frame. */
function graphicPoints(node: SexpNode[]): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  const push = (n: SexpNode[] | undefined): void => {
    if (n) pts.push({ x: num(n, 1), y: num(n, 2) });
  };
  const tag = typeof node[0] === 'string' ? node[0] : '';
  const start = child(node, 'start');
  const end = child(node, 'end');
  if (tag.endsWith('circle')) {
    const center = child(node, 'center') ?? start;
    if (center && end) {
      const cx = num(center, 1);
      const cy = num(center, 2);
      const r = Math.hypot(num(end, 1) - cx, num(end, 2) - cy);
      pts.push({ x: cx - r, y: cy - r }, { x: cx + r, y: cy + r });
      return pts;
    }
  }
  push(start);
  push(child(node, 'mid'));
  push(end);
  push(child(node, 'center'));
  for (const ptsNode of children(node, 'pts')) {
    for (const xy of children(ptsNode, 'xy')) push(xy);
  }
  return pts;
}

const GRAPHIC_TAGS = new Set([
  'gr_line',
  'gr_rect',
  'gr_arc',
  'gr_circle',
  'gr_poly',
  'gr_curve',
  'fp_line',
  'fp_rect',
  'fp_arc',
  'fp_circle',
  'fp_poly',
  'fp_curve',
]);

/** Shoelace area of one `(pts (xy ...) ...)` ring. */
function polygonArea(ptsNode: SexpNode[]): number {
  const pts = children(ptsNode, 'xy').map((xy) => ({ x: num(xy, 1), y: num(xy, 2) }));
  if (pts.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

class NetTable {
  private byId = new Map<string, string>();
  constructor(root: SexpNode[]) {
    for (const n of children(root, 'net')) {
      const id = atom(n, 1);
      if (id !== undefined && /^-?\d+$/.test(id)) this.byId.set(id, atom(n, 2) ?? '');
    }
  }
  names(): string[] {
    return [...this.byId.values()].filter((n) => n !== '');
  }
  /**
   * Resolve a node's `(net ...)` child to a name. Three encodings occur:
   * `(net 3 "GND")` (id + name), `(net 3)` (id only, resolved here), and
   * `(net "GND")` (name only). The empty net 0 reads as null.
   */
  resolve(node: SexpNode[]): string | null {
    const explicitName = child(node, 'net_name');
    if (explicitName) return atom(explicitName, 1) || null;
    const n = child(node, 'net');
    if (!n) return null;
    if (n.length >= 3) return atom(n, 2) || null;
    const only = atom(n, 1);
    if (only === undefined) return null;
    if (/^-?\d+$/.test(only)) return this.byId.get(only) || null;
    return only || null;
  }
}

function readPads(
  fp: SexpNode[],
  ref: string,
  origin: { x: number; y: number; rot: number },
  nets: NetTable,
  copperLayers: string[],
): BoardPad[] {
  const pads: BoardPad[] = [];
  for (const pad of children(fp, 'pad')) {
    const at = child(pad, 'at');
    const size = child(pad, 'size');
    const local = { x: num(at, 1), y: num(at, 2) };
    const abs = footprintLocalToBoard(origin, local);
    const width = num(size, 1);
    const height = num(size, 2, width);
    pads.push({
      ref,
      number: atom(pad, 1) ?? '',
      net: nets.resolve(pad),
      x: abs.x,
      y: abs.y,
      width,
      height,
      layers: expandCopperLayers(layersOf(pad), copperLayers),
      extent: Math.max(width, height),
      type: atom(pad, 2) ?? '',
    });
  }
  return pads;
}

function readCourtyard(
  fp: SexpNode[],
  origin: { x: number; y: number; rot: number },
): Extents | null {
  let ext: Extents | null = null;
  for (const node of fp) {
    if (!isList(node)) continue;
    const tag = typeof node[0] === 'string' ? node[0] : '';
    if (!GRAPHIC_TAGS.has(tag)) continue;
    if (!layersOf(node).some((l) => l === 'F.CrtYd' || l === 'B.CrtYd')) continue;
    for (const p of graphicPoints(node)) {
      const abs = footprintLocalToBoard(origin, p);
      ext = extendExtents(ext, abs.x, abs.y);
    }
  }
  return ext;
}

/** Parse board text. Exposed separately from `readBoard` so tests and mutation
 *  suites can score an in-memory variant without writing it to disk. */
export function parseBoard(text: string, filePath = ''): Board {
  const roots = parseSexp(text);
  const first = roots[0];
  if (first === undefined || !isList(first) || first[0] !== 'kicad_pcb') {
    throw new Error(`not a KiCad board file: ${filePath || '<text>'}`);
  }
  // A stray close-paren makes the outer `(kicad_pcb …)` end early and spills the
  // rest of the board out as sibling top-level forms. That happens in the wild
  // (one of the boards in the installed KiCad demo set is written this way), and
  // silently reporting the two footprints that landed before the break is worse
  // than reading them all. Adopt the strays as board children; reading is
  // best-effort by design and this module never writes anything back.
  const root: SexpNode[] = roots.length > 1 ? [...first, ...roots.slice(1)] : first;
  const nets = new NetTable(root);
  const layerSection = child(root, 'layers');
  const copperLayers: string[] = [];
  for (const l of layerSection ?? []) {
    if (!isList(l)) continue;
    const name = atom(l, 1);
    if (name?.endsWith('.Cu')) copperLayers.push(name);
  }
  if (!copperLayers.length) copperLayers.push('F.Cu', 'B.Cu');

  const footprints: BoardFootprint[] = [];
  for (const fp of children(root, 'footprint')) {
    const at = child(fp, 'at');
    const origin = { x: num(at, 1), y: num(at, 2), rot: num(at, 3) };
    const ref = propertyValue(fp, 'Reference') ?? '?';
    footprints.push({
      ref,
      value: propertyValue(fp, 'Value') ?? '',
      libId: atom(fp, 1) ?? '',
      layer: atom(child(fp, 'layer'), 1) ?? 'F.Cu',
      x: origin.x,
      y: origin.y,
      rot: origin.rot,
      pads: readPads(fp, ref, origin, nets, copperLayers),
      courtyard: readCourtyard(fp, origin),
    });
  }

  const segments: TrackSegment[] = [];
  for (const seg of children(root, 'segment')) {
    const start = child(seg, 'start');
    const end = child(seg, 'end');
    segments.push({
      x1: num(start, 1),
      y1: num(start, 2),
      x2: num(end, 1),
      y2: num(end, 2),
      width: num(child(seg, 'width'), 1),
      layer: atom(child(seg, 'layer'), 1) ?? '',
      net: nets.resolve(seg),
    });
  }
  // KiCad 9+ can also write curved tracks; treat each as its chord for length
  // and connectivity, which is what a quality metric needs from it.
  for (const arc of children(root, 'arc')) {
    const start = child(arc, 'start');
    const end = child(arc, 'end');
    segments.push({
      x1: num(start, 1),
      y1: num(start, 2),
      x2: num(end, 1),
      y2: num(end, 2),
      width: num(child(arc, 'width'), 1),
      layer: atom(child(arc, 'layer'), 1) ?? '',
      net: nets.resolve(arc),
    });
  }

  const vias: BoardVia[] = [];
  for (const via of children(root, 'via')) {
    const at = child(via, 'at');
    vias.push({
      x: num(at, 1),
      y: num(at, 2),
      size: num(child(via, 'size'), 1),
      drill: num(child(via, 'drill'), 1),
      layers: expandCopperLayers(layersOf(via), copperLayers),
      net: nets.resolve(via),
    });
  }

  const zones: BoardZone[] = [];
  for (const zone of children(root, 'zone')) {
    let filled = 0;
    for (const poly of children(zone, 'filled_polygon')) {
      for (const pts of children(poly, 'pts')) filled += polygonArea(pts);
    }
    zones.push({
      net: nets.resolve(zone),
      layers: expandCopperLayers(layersOf(zone), copperLayers),
      filledAreaMm2: round(filled),
    });
  }

  let outline: Extents | null = null;
  for (const node of root) {
    if (!isList(node)) continue;
    const tag = typeof node[0] === 'string' ? node[0] : '';
    if (!GRAPHIC_TAGS.has(tag)) continue;
    if (!layersOf(node).includes('Edge.Cuts')) continue;
    for (const p of graphicPoints(node)) outline = extendExtents(outline, p.x, p.y);
  }
  // Board outlines are sometimes drawn inside a footprint (a board-shape
  // footprint, or a connector that carries the edge cut-out with it).
  for (const fp of children(root, 'footprint')) {
    const at = child(fp, 'at');
    const origin = { x: num(at, 1), y: num(at, 2), rot: num(at, 3) };
    for (const node of fp) {
      if (!isList(node)) continue;
      const tag = typeof node[0] === 'string' ? node[0] : '';
      if (!GRAPHIC_TAGS.has(tag)) continue;
      if (!layersOf(node).includes('Edge.Cuts')) continue;
      for (const p of graphicPoints(node)) {
        const abs = footprintLocalToBoard(origin, p);
        outline = extendExtents(outline, abs.x, abs.y);
      }
    }
  }

  // The net table is not the whole story: KiCad 10 populates it with net 0
  // alone and writes `(net "GND")` inline everywhere else, so the board's net
  // names are the union of the table and every net resolved on an object.
  const netNames = new Set(nets.names());
  for (const fp of footprints) for (const pad of fp.pads) if (pad.net) netNames.add(pad.net);
  for (const seg of segments) if (seg.net) netNames.add(seg.net);
  for (const via of vias) if (via.net) netNames.add(via.net);
  for (const zone of zones) if (zone.net) netNames.add(zone.net);

  return {
    filePath,
    generatorVersion: atom(child(root, 'generator_version'), 1) ?? null,
    copperLayers,
    netNames: [...netNames],
    footprints,
    segments,
    vias,
    zones,
    outline,
  };
}

export async function readBoard(file: string): Promise<Board> {
  return parseBoard(await readFile(file, 'utf8'), file);
}
