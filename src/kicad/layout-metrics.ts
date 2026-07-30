import type { Constraint, ConstraintRegistry } from '../memory/constraints.js';
import {
  extentsArea,
  extentsHeight,
  extentsOverlap,
  extentsWidth,
  type Board,
  type BoardFootprint,
  type BoardPad,
  type Extents,
} from './pcb.js';

/**
 * Layout quality measurement (design D9). `computeLayoutMetrics` is a pure
 * function of a parsed board plus the constraint registry: it consults neither
 * the agent, nor the schematic, nor `kicad-cli`. A scorer that can be *told*
 * something is a scorer that can be talked out of a finding, and the layout
 * stage has already produced a run where the model reported board state that
 * contradicted tool output in the same turn.
 *
 * Two halves:
 *
 * - a **hard table**, whose rows exist only when `.copperhead/constraints.json`
 *   holds a matching key, so every row traces back to a stated requirement;
 * - a **soft scorecard**, comparative metrics rolled into a 0-100 score whose
 *   dominant term is the routed-net fraction.
 */

export type HardStatus = 'pass' | 'fail' | 'n/a';

export interface HardRow {
  /** The `.copperhead/constraints.json` key this row was derived from. */
  key: string;
  metric: string;
  expected: string;
  actual: string;
  status: HardStatus;
  /** Why a row is `n/a`, or what the measurement covered. */
  note?: string;
}

export interface SoftMetrics {
  footprints: number;
  /** Nets with two or more pads: the ones there is something to route. */
  routableNets: number;
  routedNets: number;
  routedNetFraction: number;
  unroutedNetNames: string[];
  trackLengthMm: number;
  segments: number;
  vias: number;
  zones: number;
  courtyardOverlaps: number;
  offBoardFootprints: number;
  boardAreaMm2: number;
  /** Courtyard area over board area, 0 when either is unknown. */
  placementDensity: number;
  copperAreaMm2: number;
}

export interface ScoreTerm {
  name: string;
  points: number;
  max: number;
  detail: string;
}

export interface LayoutMetrics {
  board: string;
  hard: HardRow[];
  soft: SoftMetrics;
  terms: ScoreTerm[];
  /** 0-100, the sum of the score terms. */
  score: number;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const round = (n: number, places = 2): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------

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
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** Endpoints bucketed into 1 mm cells per layer, for tolerance lookups. */
class PointIndex {
  private cells = new Map<string, { x: number; y: number; id: string }[]>();
  private static cell(layer: string, x: number, y: number): string {
    return `${layer}|${Math.floor(x)}|${Math.floor(y)}`;
  }
  add(layer: string, x: number, y: number, id: string): void {
    const k = PointIndex.cell(layer, x, y);
    const bucket = this.cells.get(k);
    if (bucket) bucket.push({ x, y, id });
    else this.cells.set(k, [{ x, y, id }]);
  }
  near(layer: string, x: number, y: number, tol: number): string[] {
    const out: string[] = [];
    const span = Math.max(1, Math.ceil(tol));
    for (let dx = -span; dx <= span; dx++) {
      for (let dy = -span; dy <= span; dy++) {
        const bucket = this.cells.get(PointIndex.cell(layer, x + dx, y + dy));
        if (!bucket) continue;
        for (const p of bucket) {
          if (Math.hypot(p.x - x, p.y - y) <= tol) out.push(p.id);
        }
      }
    }
    return out;
  }
}

const nodeKey = (layer: string, x: number, y: number): string =>
  `${layer}|${Math.round(x * 1000)}|${Math.round(y * 1000)}`;

/**
 * Approximate copper connectivity by union-find over quantized points. A
 * segment unions its endpoints; a via unions coincident points across the
 * layers it spans; a pad unions with any track endpoint within
 * `max(padExtent / 2, 0.05 mm)`; a zone on a net unions every pad on that net,
 * because a pour is copper.
 *
 * Deliberately approximate: this is a quality metric, not a netlist extractor,
 * and it over-credits (a zone is assumed to reach the pads on its net) rather
 * than under-credits, so it does not flag good boards. The corpus test on the
 * labeled routed/unrouted pair is what calibrates it.
 */
function buildConnectivity(board: Board): { uf: UnionFind; padNode: Map<BoardPad, string> } {
  const uf = new UnionFind();
  const index = new PointIndex();

  for (const seg of board.segments) {
    if (!seg.layer.endsWith('.Cu')) continue;
    const a = nodeKey(seg.layer, seg.x1, seg.y1);
    const b = nodeKey(seg.layer, seg.x2, seg.y2);
    uf.union(a, b);
    index.add(seg.layer, seg.x1, seg.y1, a);
    index.add(seg.layer, seg.x2, seg.y2, b);
  }

  for (const via of board.vias) {
    const tol = Math.max(via.size / 2, 0.05);
    const layers = via.layers.length ? via.layers : board.copperLayers;
    const own = layers.map((l) => nodeKey(l, via.x, via.y));
    for (let i = 1; i < own.length; i++) uf.union(own[0]!, own[i]!);
    for (const [i, layer] of layers.entries()) {
      for (const id of index.near(layer, via.x, via.y, tol)) uf.union(own[i]!, id);
      index.add(layer, via.x, via.y, own[i]!);
    }
  }

  const padNode = new Map<BoardPad, string>();
  let padSeq = 0;
  for (const fp of board.footprints) {
    for (const pad of fp.pads) {
      const id = `pad:${padSeq++}`;
      padNode.set(pad, id);
      const tol = Math.max(pad.extent / 2, 0.05);
      const layers = pad.layers.length ? pad.layers : board.copperLayers;
      for (const layer of layers) {
        for (const other of index.near(layer, pad.x, pad.y, tol)) uf.union(id, other);
      }
    }
  }

  // A filled pour is copper: credit every pad on the zone's net, regardless of
  // which layer the pour sits on, because a real ground pour reaches its pads
  // through stitching the geometry here does not model. Over-crediting is the
  // trade-off named above; the mutation that deletes the ground zone is what
  // keeps it honest.
  for (const [i, zone] of board.zones.entries()) {
    if (!zone.net) continue;
    const zoneId = `zone:${i}`;
    for (const fp of board.footprints) {
      for (const pad of fp.pads) {
        if (pad.net === zone.net) uf.union(zoneId, padNode.get(pad)!);
      }
    }
  }

  return { uf, padNode };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const segLength = (s: { x1: number; y1: number; x2: number; y2: number }): number =>
  Math.hypot(s.x2 - s.x1, s.y2 - s.y1);

function pointToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Euclidean minimum spanning tree length over a pad cloud (Prim, O(n²)). */
function mstLength(points: { x: number; y: number }[]): number {
  const n = points.length;
  if (n < 2) return 0;
  const inTree = new Array<boolean>(n).fill(false);
  const best = new Array<number>(n).fill(Infinity);
  best[0] = 0;
  let total = 0;
  for (let iter = 0; iter < n; iter++) {
    let pick = -1;
    for (let i = 0; i < n; i++) if (!inTree[i] && (pick === -1 || best[i]! < best[pick]!)) pick = i;
    if (pick === -1) break;
    inTree[pick] = true;
    total += best[pick]!;
    const p = points[pick]!;
    for (let i = 0; i < n; i++) {
      if (inTree[i]) continue;
      const d = Math.hypot(points[i]!.x - p.x, points[i]!.y - p.y);
      if (d < best[i]!) best[i] = d;
    }
  }
  return total;
}

const footprintExtents = (fp: BoardFootprint): Extents =>
  fp.courtyard ?? { minX: fp.x, minY: fp.y, maxX: fp.x, maxY: fp.y };

/** Net-name heuristics. Used only to pick which nets a width or copper-area
 *  constraint is about; nothing depends on them being exhaustive. */
export function isGroundNet(name: string): boolean {
  return /^[+\-/]*(?:a|d|p|e)?gnd\b|^[+\-/]*(?:gnd|ground|vss)\b/i.test(name.trim());
}

export function isPowerNet(name: string): boolean {
  const n = name.trim().replace(/^[+\-/]+/, '');
  if (isGroundNet(name)) return true;
  if (/^(?:vcc|vdd|vee|vbus|vin|vout|vbat|vsys|vmot|pwr|power|batt?|mains|rail)\b/i.test(n)) return true;
  // +5V, 3V3, 12V, 1V8 and friends.
  return /^\d+v\d*$/i.test(n) || /^v\d+(?:v\d+)?$/i.test(n);
}

const isCapacitor = (ref: string): boolean => /^C\d/i.test(ref);
const isMountingHole = (fp: BoardFootprint): boolean =>
  /^(?:H|MH|MK)\d/i.test(fp.ref) || /mountinghole/i.test(fp.libId);

// ---------------------------------------------------------------------------
// Soft metrics
// ---------------------------------------------------------------------------

interface Derived {
  soft: SoftMetrics;
  padsByNet: Map<string, BoardPad[]>;
  copperByNet: Map<string, number>;
  trackLengthByNet: Map<string, number>;
  routedNetSet: Set<string>;
}

function derive(board: Board): Derived {
  const { uf, padNode } = buildConnectivity(board);

  const padsByNet = new Map<string, BoardPad[]>();
  const copperByNet = new Map<string, number>();
  const addCopper = (net: string | null, area: number): void => {
    if (!net) return;
    copperByNet.set(net, (copperByNet.get(net) ?? 0) + area);
  };
  for (const fp of board.footprints) {
    for (const pad of fp.pads) {
      if (pad.net) {
        const list = padsByNet.get(pad.net);
        if (list) list.push(pad);
        else padsByNet.set(pad.net, [pad]);
      }
      addCopper(pad.net, pad.width * pad.height);
    }
  }

  const trackLengthByNet = new Map<string, number>();
  let trackLengthMm = 0;
  for (const seg of board.segments) {
    const len = segLength(seg);
    trackLengthMm += len;
    if (seg.net) trackLengthByNet.set(seg.net, (trackLengthByNet.get(seg.net) ?? 0) + len);
    addCopper(seg.net, len * seg.width);
  }
  for (const via of board.vias) addCopper(via.net, Math.PI * (via.size / 2) ** 2);
  for (const zone of board.zones) addCopper(zone.net, zone.filledAreaMm2);

  const routedNetSet = new Set<string>();
  const unroutedNetNames: string[] = [];
  let routableNets = 0;
  for (const [net, pads] of padsByNet) {
    if (pads.length < 2) continue;
    routableNets++;
    const root = uf.find(padNode.get(pads[0]!)!);
    const joined = pads.every((p) => uf.find(padNode.get(p)!) === root);
    if (joined) routedNetSet.add(net);
    else unroutedNetNames.push(net);
  }
  unroutedNetNames.sort();

  let courtyardOverlaps = 0;
  const placed = board.footprints.filter((f) => f.courtyard);
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]!;
      const b = placed[j]!;
      if (a.layer !== b.layer) continue;
      if (extentsOverlap(a.courtyard!, b.courtyard!)) courtyardOverlaps++;
    }
  }

  const outline = board.outline;
  let offBoardFootprints = 0;
  if (outline) {
    const tol = 0.01;
    for (const fp of board.footprints) {
      const e = footprintExtents(fp);
      if (
        e.minX < outline.minX - tol ||
        e.minY < outline.minY - tol ||
        e.maxX > outline.maxX + tol ||
        e.maxY > outline.maxY + tol
      ) {
        offBoardFootprints++;
      }
    }
  }

  const boardAreaMm2 = outline ? extentsArea(outline) : 0;
  const courtyardArea = placed.reduce((a, f) => a + extentsArea(f.courtyard!), 0);
  const placementDensity = boardAreaMm2 > 0 ? clamp01(courtyardArea / boardAreaMm2) : 0;
  const copperAreaMm2 = [...copperByNet.values()].reduce((a, b) => a + b, 0);

  return {
    soft: {
      footprints: board.footprints.length,
      routableNets,
      routedNets: routedNetSet.size,
      routedNetFraction: routableNets ? routedNetSet.size / routableNets : 0,
      unroutedNetNames,
      trackLengthMm: round(trackLengthMm),
      segments: board.segments.length,
      vias: board.vias.length,
      zones: board.zones.length,
      courtyardOverlaps,
      offBoardFootprints,
      boardAreaMm2: round(boardAreaMm2),
      placementDensity: round(placementDensity, 4),
      copperAreaMm2: round(copperAreaMm2),
    },
    padsByNet,
    copperByNet,
    trackLengthByNet,
    routedNetSet,
  };
}

/** Pad clouds larger than this skip the O(n²) MST: a 2000-pad ground net costs
 *  four million distance evaluations and tells us nothing a smaller net does not. */
const MST_PAD_LIMIT = 600;

function routingDirectness(d: Derived, pourNets: Set<string>): { ratio: number; ideal: number; actual: number } {
  let ideal = 0;
  let actual = 0;
  let weighted = 0;
  for (const net of d.routedNetSet) {
    // A net with a pour on it is connected by copper the track length does not
    // account for, so its ideal/actual ratio says nothing about routing quality.
    if (pourNets.has(net)) continue;
    const pads = d.padsByNet.get(net) ?? [];
    if (pads.length > MST_PAD_LIMIT) continue;
    const length = d.trackLengthByNet.get(net) ?? 0;
    if (length <= 0) continue;
    const mst = mstLength(pads.map((p) => ({ x: p.x, y: p.y })));
    ideal += mst;
    actual += length;
    weighted += clamp01(mst / length) * length;
  }
  return { ratio: actual > 0 ? clamp01(weighted / actual) : 0, ideal: round(ideal), actual: round(actual) };
}

/**
 * The 0-100 roll-up. Routed-net fraction is the dominant term (40 points) so an
 * empty board can never tie a finished one, and the placement terms are zeroed
 * (not awarded) when there is nothing placed, so an empty board cannot bank
 * points for the overlaps it does not have.
 */
function scoreTerms(soft: SoftMetrics, hard: HardRow[], directness: ReturnType<typeof routingDirectness>): ScoreTerm[] {
  const decided = hard.filter((r) => r.status !== 'n/a');
  const hardPass = decided.filter((r) => r.status === 'pass').length;
  const undecided = hard.length - decided.length;
  const fp = soft.footprints;
  // On a populated board an n/a row forfeits the whole term. Excluding n/a
  // rows from the denominator let deleting the component a constraint polices
  // score HIGHER than misplacing it (the fail row vanished and the hard term
  // sprang back to full marks). Forfeiting instead means an n/a row can never
  // shrink the denominator and can never score above the same row failing, so
  // a fail turning n/a, deletion included, never improves this term. The soft
  // terms are measured on whatever remains and move on their own. The empty
  // scaffold keeps the exclusion behaviour: with nothing placed yet, n/a is
  // the honest default, and the placement and routing terms already hold its
  // score down.
  const hardFraction = fp
    ? hard.length === 0
      ? 1
      : undecided
        ? 0
        : hardPass / hard.length
    : decided.length
      ? hardPass / decided.length
      : 1;
  const TARGET_DENSITY = 0.35;
  return [
    {
      name: 'Routed nets',
      max: 40,
      points: round(40 * soft.routedNetFraction),
      detail: `${soft.routedNets}/${soft.routableNets} multi-pad nets joined in copper`,
    },
    {
      name: 'Hard constraints',
      max: 20,
      points: round(20 * hardFraction),
      detail:
        fp && undecided
          ? `${undecided} n/a row(s) forfeit the term: a populated board must answer every constraint`
          : decided.length
            ? `${hardPass}/${decided.length} constraint rows pass`
            : 'no matching constraint keys',
    },
    {
      name: 'Courtyard clearance',
      max: 12,
      points: fp ? round(12 * clamp01(1 - soft.courtyardOverlaps / fp)) : 0,
      detail: fp ? `${soft.courtyardOverlaps} overlapping courtyard pair(s)` : 'nothing placed',
    },
    {
      name: 'On-board placement',
      max: 12,
      points: fp ? round(12 * clamp01(1 - soft.offBoardFootprints / fp)) : 0,
      detail: fp ? `${soft.offBoardFootprints}/${fp} footprint(s) outside the outline` : 'nothing placed',
    },
    {
      name: 'Placement density',
      max: 8,
      points: fp && soft.boardAreaMm2 > 0 ? round(8 * clamp01(soft.placementDensity / TARGET_DENSITY)) : 0,
      detail:
        fp && soft.boardAreaMm2 > 0
          ? `${(soft.placementDensity * 100).toFixed(1)}% of the outline covered by courtyards`
          : 'no placed footprints inside a known outline',
    },
    {
      name: 'Routing directness',
      max: 8,
      points: round(8 * directness.ratio),
      detail: directness.actual
        ? `${directness.ideal} mm ideal vs ${directness.actual} mm routed`
        : 'no routed net carries track copper',
    },
  ];
}

// ---------------------------------------------------------------------------
// Hard table
// ---------------------------------------------------------------------------

interface HardContext {
  board: Board;
  derived: Derived;
}

const fmt = (n: number, unit: string, places = 3): string => `${round(n, places)} ${unit}`;

function bound(c: Constraint, unit: string): { expected: string; test: ((v: number) => boolean) | null } {
  if (c.min !== undefined && c.max !== undefined) {
    return {
      expected: `${c.min} to ${c.max} ${unit}`,
      test: (v) => v >= c.min! - 1e-9 && v <= c.max! + 1e-9,
    };
  }
  if (c.min !== undefined) return { expected: `>= ${c.min} ${unit}`, test: (v) => v >= c.min! - 1e-9 };
  if (c.max !== undefined) return { expected: `<= ${c.max} ${unit}`, test: (v) => v <= c.max! + 1e-9 };
  return { expected: 'no numeric bound recorded', test: null };
}

function decide(key: string, metric: string, c: Constraint, unit: string, measured: number): HardRow {
  const { expected, test } = bound(c, unit);
  if (!test) {
    return { key, metric, expected, actual: fmt(measured, unit), status: 'n/a', note: 'constraint records no min/max' };
  }
  return { key, metric, expected, actual: fmt(measured, unit), status: test(measured) ? 'pass' : 'fail' };
}

const na = (key: string, metric: string, expected: string, note: string): HardRow => ({
  key,
  metric,
  expected,
  actual: 'not measurable',
  status: 'n/a',
  note,
});

/** Refdes-looking tokens a constraint names, so a keepout row knows what it is between. */
function referencedRefdes(c: Constraint): string[] {
  const text = [typeof c.value === 'string' ? c.value : '', ...(c.affects ?? []), ...(c.forbidden ?? [])].join(' ');
  return [...new Set(text.match(/\b[A-Z]{1,3}\d+\b/g) ?? [])];
}

/** Net names a constraint names, matched against the board's own net table. */
function referencedNet(c: Constraint, board: Board): string | null {
  const text = [typeof c.value === 'string' ? c.value : '', ...(c.affects ?? [])].join(' ');
  for (const net of board.netNames) {
    if (text.includes(net)) return net;
  }
  return null;
}

function traceWidthRow(key: string, c: Constraint, ctx: HardContext): HardRow {
  const named = referencedNet(c, ctx.board);
  const widths = ctx.board.segments
    .filter((s) => s.net && s.width > 0 && (named ? s.net === named : isPowerNet(s.net)))
    .map((s) => s.width);
  if (!widths.length) {
    return na(key, 'Narrowest current-carrying track', bound(c, 'mm').expected, named ? `no tracks on net ${named}` : 'no tracks on a power net');
  }
  const row = decide(key, 'Narrowest current-carrying track', c, 'mm', Math.min(...widths));
  row.note = named ? `net ${named}` : `${widths.length} segment(s) on power nets`;
  return row;
}

function boardOutlineRow(key: string, c: Constraint, ctx: HardContext): HardRow {
  const outline = ctx.board.outline;
  if (!outline) return na(key, 'Board outline', 'within the stated outline', 'the board has no Edge.Cuts outline');
  const w = extentsWidth(outline);
  const h = extentsHeight(outline);
  const actual = `${round(w)} x ${round(h)} mm`;
  const size = (typeof c.value === 'string' ? c.value : '').match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/);
  if (size) {
    const ew = parseFloat(size[1]!);
    const eh = parseFloat(size[2]!);
    const fits =
      (w <= ew + 0.01 && h <= eh + 0.01) || (w <= eh + 0.01 && h <= ew + 0.01);
    return { key, metric: 'Board outline', expected: `<= ${ew} x ${eh} mm`, actual, status: fits ? 'pass' : 'fail' };
  }
  if (c.max !== undefined) {
    return {
      key,
      metric: 'Board outline',
      expected: `largest dimension <= ${c.max} mm`,
      actual,
      status: Math.max(w, h) <= c.max + 0.01 ? 'pass' : 'fail',
    };
  }
  return na(key, 'Board outline', 'within the stated outline', `constraint value "${String(c.value ?? '')}" states no WxH or max`);
}

function keepoutRow(key: string, c: Constraint, ctx: HardContext): HardRow {
  const refs = referencedRefdes(c);
  const found = refs
    .map((r) => ctx.board.footprints.find((f) => f.ref === r))
    .filter((f): f is BoardFootprint => !!f);
  const expected = bound(c, 'mm').expected;
  if (found.length !== 2) {
    return na(
      key,
      'Keepout separation',
      expected,
      `needs exactly two refdes on the board; the constraint names ${refs.length ? refs.join(', ') : 'none'}`,
    );
  }
  const [a, b] = found as [BoardFootprint, BoardFootprint];
  const row = decide(key, `Keepout separation ${a.ref} to ${b.ref}`, c, 'mm', Math.hypot(a.x - b.x, a.y - b.y));
  row.note = 'centroid to centroid';
  return row;
}

function mountingHoleRow(key: string, c: Constraint, ctx: HardContext): HardRow {
  const holes = ctx.board.footprints.filter(isMountingHole);
  const expected = bound(c, 'mm').expected;
  if (!holes.length) return na(key, 'Mounting hole copper clearance', expected, 'the board has no mounting holes');
  const holeRefs = new Set(holes.map((h) => h.ref));
  let min = Infinity;
  for (const hole of holes) {
    const anchors = hole.pads.length
      ? hole.pads.map((p) => ({ x: p.x, y: p.y, r: p.extent / 2 }))
      : [{ x: hole.x, y: hole.y, r: 0 }];
    for (const anchor of anchors) {
      for (const seg of ctx.board.segments) {
        const d = pointToSegment(anchor.x, anchor.y, seg.x1, seg.y1, seg.x2, seg.y2) - seg.width / 2 - anchor.r;
        if (d < min) min = d;
      }
      for (const via of ctx.board.vias) {
        const d = Math.hypot(via.x - anchor.x, via.y - anchor.y) - via.size / 2 - anchor.r;
        if (d < min) min = d;
      }
      for (const fp of ctx.board.footprints) {
        if (holeRefs.has(fp.ref)) continue;
        for (const pad of fp.pads) {
          const d = Math.hypot(pad.x - anchor.x, pad.y - anchor.y) - pad.extent / 2 - anchor.r;
          if (d < min) min = d;
        }
      }
    }
  }
  if (!Number.isFinite(min)) return na(key, 'Mounting hole copper clearance', expected, 'the board has no copper to measure against');
  const row = decide(key, 'Mounting hole copper clearance', c, 'mm', min);
  row.note = `nearest copper to any of ${holes.length} mounting hole(s)`;
  return row;
}

function decouplingRow(key: string, c: Constraint, ctx: HardContext): HardRow {
  const expected = bound(c, 'mm').expected;
  let worst = -Infinity;
  let worstLabel = '';
  let counted = 0;
  for (const cap of ctx.board.footprints) {
    if (!isCapacitor(cap.ref)) continue;
    const nets = cap.pads.map((p) => p.net).filter((n): n is string => !!n);
    const rail = cap.pads.find((p) => p.net && isPowerNet(p.net) && !isGroundNet(p.net));
    const hasGround = nets.some(isGroundNet);
    if (!rail || !hasGround) continue;
    let nearest = Infinity;
    let nearestRef = '';
    for (const fp of ctx.board.footprints) {
      if (fp.ref === cap.ref || isCapacitor(fp.ref) || isMountingHole(fp)) continue;
      for (const pad of fp.pads) {
        if (pad.net !== rail.net) continue;
        const d = Math.hypot(pad.x - rail.x, pad.y - rail.y);
        if (d < nearest) {
          nearest = d;
          nearestRef = `${fp.ref}.${pad.number}`;
        }
      }
    }
    if (!Number.isFinite(nearest)) continue;
    counted++;
    if (nearest > worst) {
      worst = nearest;
      worstLabel = `${cap.ref} to ${nearestRef}`;
    }
  }
  if (!counted) return na(key, 'Decoupling pad-to-pin distance', expected, 'no bypass capacitor sits between a rail and ground');
  const row = decide(key, 'Decoupling pad-to-pin distance', c, 'mm', worst);
  row.note = `worst of ${counted} bypass cap(s): ${worstLabel}`;
  return row;
}

function copperAreaRow(key: string, c: Constraint, ctx: HardContext): HardRow {
  const expected = bound(c, 'mm²').expected;
  const named = referencedNet(c, ctx.board);
  if (!named) {
    return na(key, 'Copper area on the named net', expected, 'the constraint names no net present on this board');
  }
  const row = decide(key, `Copper area on ${named}`, c, 'mm²', ctx.derived.copperByNet.get(named) ?? 0);
  row.note = 'tracks, pads, vias and filled zones on that net';
  return row;
}

/**
 * Suffix-matched, so a project's own naming (`mech.load_trace_width_mm`,
 * `pwr.trace_width_mm`) all land on the same measurement. Order matters only in
 * that the first matching suffix wins.
 */
const HARD_MATCHERS: { suffix: string; build: (key: string, c: Constraint, ctx: HardContext) => HardRow }[] = [
  { suffix: 'trace_width_mm', build: traceWidthRow },
  { suffix: 'board_outline_mm', build: boardOutlineRow },
  { suffix: 'keepout', build: keepoutRow },
  { suffix: 'mounting_hole_clearance_mm', build: mountingHoleRow },
  { suffix: 'decoupling_distance_mm', build: decouplingRow },
  { suffix: 'copper_area_mm2', build: copperAreaRow },
];

function hardTable(board: Board, constraints: ConstraintRegistry, derived: Derived): HardRow[] {
  const ctx: HardContext = { board, derived };
  const rows: HardRow[] = [];
  for (const key of Object.keys(constraints).sort()) {
    const c = constraints[key]!;
    const matcher = HARD_MATCHERS.find((m) => key.toLowerCase().endsWith(m.suffix));
    if (!matcher) continue;
    rows.push(matcher.build(key, c, ctx));
  }
  return rows;
}

export function computeLayoutMetrics(board: Board, constraints: ConstraintRegistry): LayoutMetrics {
  const derived = derive(board);
  const hard = hardTable(board, constraints, derived);
  const pourNets = new Set(board.zones.map((z) => z.net).filter((n): n is string => !!n));
  const directness = routingDirectness(derived, pourNets);
  const terms = scoreTerms(derived.soft, hard, directness);
  return {
    board: board.filePath,
    hard,
    soft: derived.soft,
    terms,
    score: round(terms.reduce((a, t) => a + t.points, 0), 1),
  };
}
