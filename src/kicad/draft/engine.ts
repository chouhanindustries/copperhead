import type { Bounds } from '../sexp.js';
import type { PlacementModel, EmitSymbol } from '../emit.js';
import { powerSymbolSource, pwrFlagSource, type ResolvedSymbol, type DraftPin } from './symsource.js';
import type { SchematicIntent, IntentNet, IntentPart, ValidatedIntent } from './ir.js';

/**
 * The rule-based deterministic drafting engine (design D1/D2). All geometry is
 * computed in integer multiples of the 1.27mm grid, so every pin lands on-grid
 * by construction. No randomness, no clock, no environment-dependent ordering:
 * identical IR yields an identical placement model on every machine.
 */

/** The grid. Every symbol origin and wire endpoint is an integer multiple. */
const U = 1.27;
/** Stub length from a pin to its label/power symbol, in grid units. */
const STUB = 2;
/** Cell margin around a symbol body (room for stubs, labels, text), in units. */
const MARGIN = 6;
/** Vertical gap between rows and horizontal channel between columns, units. */
const ROW_GAP = 4;
const CHANNEL = 8;
/** Gap between group boxes, units. */
const GROUP_GAP = 8;
/** Local nets up to this many endpoints may be wired (design D2). */
const MAX_WIRED_ENDPOINTS = 4;
/** Wire-span budget in mm beyond which a net becomes labels. */
const MAX_WIRE_SPAN = 50.8;

const ceilU = (mm: number): number => Math.ceil(mm / U - 1e-9);
const grid = (units: number): number => Math.round(units) * U;

/** Standard landscape sheets, smallest first, for content-derived paper. */
const PAPERS: { name: string; w: number; h: number }[] = [
  { name: 'A5', w: 210, h: 148 },
  { name: 'A4', w: 297, h: 210 },
  { name: 'A3', w: 420, h: 297 },
  { name: 'A2', w: 594, h: 420 },
  { name: 'A1', w: 841, h: 594 },
  { name: 'A0', w: 1189, h: 841 },
];
const FRAME = 10;
const TITLE_STRIP = 30;

export type NetClass = 'rail' | 'ground' | 'signal';

export interface DraftReport {
  groups: { name: string; members: string[] }[];
  netClasses: { name: string; class: NetClass; overridden: boolean }[];
  wireCount: number;
  labelCount: number;
  pwrFlags: string[];
  noConnects: number;
  paper: string;
  notes: string[];
}

interface Placed {
  part: IntentPart;
  sym: ResolvedSymbol;
  /** Origin, mm (grid multiple). */
  x: number;
  y: number;
  body: Bounds; // schematic space, absolute
  cellW: number; // units
  cellH: number; // units
}

const bodyBoundsOf = (sym: ResolvedSymbol): Bounds => {
  if (sym.body) return sym.body;
  const xs = sym.pins.map((p) => p.x);
  const ys = sym.pins.map((p) => p.y);
  if (!xs.length) return { minX: -U, minY: -U, maxX: U, maxY: U };
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
};

/** Pin connection point in schematic space for a part placed at (x, y), rot 0. */
const pinAt = (p: Placed, pin: DraftPin): { x: number; y: number } => ({ x: p.x + pin.x, y: p.y - pin.y });

/** Outward direction of a pin (away from the body), schematic space. */
function outward(pin: DraftPin): { dx: number; dy: number } {
  // pin angle points from the connection point toward the body (symbol space,
  // Y-up); outward is the opposite, with Y flipped into schematic space.
  const a = ((pin.angle % 360) + 360) % 360;
  if (a === 0) return { dx: -1, dy: 0 };
  if (a === 180) return { dx: 1, dy: 0 };
  if (a === 90) return { dx: 0, dy: 1 };
  return { dx: 0, dy: -1 };
}

function classifyNet(net: IntentNet, pinsOf: (ep: string) => DraftPin | null): { cls: NetClass; overridden: boolean } {
  if (net.kind === 'power') return { cls: 'rail', overridden: true };
  if (net.kind === 'ground') return { cls: 'ground', overridden: true };
  if (net.kind === 'signal') return { cls: 'signal', overridden: true };
  const touchesPower = net.pins.some((ep) => {
    const p = pinsOf(ep);
    return p !== null && (p.etype === 'power_in' || p.etype === 'power_out');
  });
  if (!touchesPower) return { cls: 'signal', overridden: false };
  return { cls: /gnd|vss/i.test(net.name) ? 'ground' : 'rail', overridden: false };
}

const segCrossesBody = (x1: number, y1: number, x2: number, y2: number, b: Bounds): boolean => {
  const inX = Math.max(Math.min(x1, x2), b.minX) < Math.min(Math.max(x1, x2), b.maxX) - 0.01;
  const inY = Math.max(Math.min(y1, y2), b.minY) < Math.min(Math.max(y1, y2), b.maxY) - 0.01;
  if (x1 === x2) return x1 > b.minX + 0.01 && x1 < b.maxX - 0.01 && inY;
  if (y1 === y2) return y1 > b.minY + 0.01 && y1 < b.maxY - 0.01 && inX;
  return inX && inY; // conservative for diagonals (the engine never draws them)
};

export function draftPlacement(validated: ValidatedIntent, projectName: string, today: string): { model: PlacementModel; report: DraftReport } {
  const { intent, symbols, docGroups } = validated;
  const notes: string[] = [];

  // ---------- net classification (deterministic, visible in the report) ----------
  const partByRef = new Map(intent.parts.map((p) => [p.ref, p]));
  const pinLookup = (ep: string): DraftPin | null => {
    const m = /^([^.]+)\.(.+)$/.exec(ep);
    if (!m) return null;
    const sym = symbols.get(m[1]!);
    return sym?.pins.find((p) => p.number === m[2]) ?? null;
  };
  const netClasses = new Map<string, { cls: NetClass; overridden: boolean }>();
  for (const net of intent.nets) netClasses.set(net.name, classifyNet(net, pinLookup));
  const powerNets = intent.nets.filter((n) => netClasses.get(n.name)!.cls !== 'signal');
  const signalNets = intent.nets.filter((n) => netClasses.get(n.name)!.cls === 'signal');

  // ---------- reductions: decoupling caps and connectors ----------
  const isCap = (p: IntentPart): boolean => /^Device:C(_|$)|^Device:C$/.test(p.libId) || p.libId === 'Device:C_Polarized';
  const railOf = (ref: string): string | null => {
    for (const net of powerNets) {
      if (netClasses.get(net.name)!.cls !== 'rail') continue;
      if (net.pins.some((ep) => ep.startsWith(`${ref}.`))) return net.name;
    }
    return null;
  };
  const touchesGround = (ref: string): boolean =>
    powerNets.some((n) => netClasses.get(n.name)!.cls === 'ground' && n.pins.some((ep) => ep.startsWith(`${ref}.`)));

  const decapOwner = new Map<string, string>(); // cap ref -> owner IC ref
  for (const p of intent.parts) {
    const sym = symbols.get(p.ref)!;
    if (sym.isPower || !isCap(p) || sym.pins.length !== 2) continue;
    const rail = railOf(p.ref);
    if (!rail || !touchesGround(p.ref)) continue;
    // owner: an IC (3+ pins) on the same rail — same group first, then most
    // shared nets, then refdes order (deterministic tie-break, engine spec)
    const candidates = intent.parts
      .filter((c) => c.ref !== p.ref && (symbols.get(c.ref)?.pins.length ?? 0) >= 3 && railOf(c.ref) === rail)
      .map((c) => ({
        ref: c.ref,
        sameGroup: c.group === p.group ? 1 : 0,
        shared: intent.nets.filter((n) => n.pins.some((e) => e.startsWith(`${c.ref}.`)) && n.pins.some((e) => e.startsWith(`${p.ref}.`))).length,
      }))
      .sort((a, b) => b.sameGroup - a.sameGroup || b.shared - a.shared || a.ref.localeCompare(b.ref, undefined, { numeric: true }));
    if (candidates.length) decapOwner.set(p.ref, candidates[0]!.ref);
  }
  const isConnector = (p: IntentPart): boolean => p.libId.startsWith('Connector');

  // ---------- group ordering: hints, then SUBSYSTEMS.md order, then name ----------
  const groupNames = [...new Set(intent.parts.filter((p) => !symbols.get(p.ref)!.isPower).map((p) => p.group))];
  const orderIndex = (g: string): number => {
    const hinted = intent.hints?.groupOrder?.findIndex((h) => h.toLowerCase() === g.toLowerCase());
    if (hinted !== undefined && hinted >= 0) return hinted;
    const doc = docGroups?.findIndex((h) => h.toLowerCase() === g.toLowerCase());
    if (doc !== undefined && doc >= 0) return 1000 + doc;
    return 2000;
  };
  groupNames.sort((a, b) => orderIndex(a) - orderIndex(b) || a.localeCompare(b));

  // ---------- in-group placement: layering + barycenter, integer grid ----------
  const placed = new Map<string, Placed>();
  const groupRects: { name: string; x1: number; y1: number; x2: number; y2: number }[] = [];
  const groupOf = new Map<string, string>();
  let groupX = 0; // running x origin (units) for group tiling

  for (const gname of groupNames) {
    const members = intent.parts.filter(
      (p) => p.group === gname && !symbols.get(p.ref)!.isPower && !decapOwner.has(p.ref),
    );
    const caps = intent.parts.filter((p) => p.group === gname && decapOwner.has(p.ref));
    for (const p of [...members, ...caps]) groupOf.set(p.ref, gname);

    // layer assignment: connectors at depth 0; signal edges push depth forward
    const depth = new Map<string, number>(members.map((m) => [m.ref, isConnector(m) ? 0 : 1]));
    const edges: { from: string; to: string }[] = [];
    for (const net of signalNets) {
      const eps = net.pins
        .map((ep) => /^([^.]+)\./.exec(ep)?.[1] ?? '')
        .filter((r) => members.some((m) => m.ref === r));
      const uniq = [...new Set(eps)];
      for (let i = 0; i < uniq.length; i++) {
        for (let j = i + 1; j < uniq.length; j++) {
          const [a, b] = [uniq[i]!, uniq[j]!].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
          edges.push({ from: a!, to: b! });
        }
      }
    }
    for (let iter = 0; iter < members.length; iter++) {
      let changed = false;
      for (const e of edges) {
        const want = (depth.get(e.from) ?? 0) + 1;
        if ((depth.get(e.to) ?? 0) < want && want <= members.length) {
          depth.set(e.to, want);
          changed = true;
        }
      }
      if (!changed) break;
    }
    const depths = [...new Set([...depth.values()])].sort((a, b) => a - b);
    const columns: string[][] = depths.map((d) => members.filter((m) => depth.get(m.ref) === d).map((m) => m.ref));

    // barycenter row ordering (two sweeps), refdes as the deterministic tie
    const rowOf = new Map<string, number>();
    columns.forEach((col) => col.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).forEach((r, i) => rowOf.set(r, i)));
    for (let sweep = 0; sweep < 2; sweep++) {
      for (let ci = 1; ci < columns.length; ci++) {
        const col = columns[ci]!;
        const bary = (ref: string): number => {
          const neigh = edges
            .filter((e) => e.from === ref || e.to === ref)
            .map((e) => (e.from === ref ? e.to : e.from))
            .filter((o) => rowOf.has(o));
          if (!neigh.length) return rowOf.get(ref)!;
          return neigh.reduce((s, o) => s + rowOf.get(o)!, 0) / neigh.length;
        };
        col.sort((a, b) => bary(a) - bary(b) || a.localeCompare(b, undefined, { numeric: true })).forEach((r, i) => rowOf.set(r, i));
      }
    }

    // cells: sized from body plus margins, positions snapped to the grid
    const cellDims = new Map<string, { w: number; h: number; body: Bounds }>();
    for (const m of members) {
      const b = bodyBoundsOf(symbols.get(m.ref)!);
      cellDims.set(m.ref, {
        w: ceilU(b.maxX - b.minX) + 2 * MARGIN,
        h: ceilU(b.maxY - b.minY) + 2 * MARGIN,
        body: b,
      });
    }
    let colX = groupX;
    let groupMaxY = 0;
    for (const col of columns) {
      const colW = Math.max(...col.map((r) => cellDims.get(r)!.w));
      let rowY = 0;
      for (const ref of col) {
        const dims = cellDims.get(ref)!;
        const cx = colX + Math.floor(colW / 2); // shared column axis (units)
        const cy = rowY + Math.floor(dims.h / 2);
        const b = dims.body;
        // origin so the body centers on the cell center, snapped to grid
        const ox = grid(cx - Math.round((b.minX + b.maxX) / 2 / U));
        const oy = grid(cy + Math.round((b.minY + b.maxY) / 2 / U));
        const sym = symbols.get(ref)!;
        placed.set(ref, {
          part: partByRef.get(ref)!,
          sym,
          x: ox,
          y: oy,
          body: { minX: ox + b.minX, minY: oy - b.maxY, maxX: ox + b.maxX, maxY: oy - b.minY },
          cellW: dims.w,
          cellH: dims.h,
        });
        rowY += dims.h + ROW_GAP;
      }
      groupMaxY = Math.max(groupMaxY, rowY - ROW_GAP);
      colX += colW + CHANNEL;
    }

    // decoupling rows: caps in a uniform row under their owner (or the group)
    const capRefs = caps.map((c) => c.ref).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (capRefs.length) {
      let capX = groupX;
      const capY = groupMaxY + MARGIN + 4;
      for (const ref of capRefs) {
        const sym = symbols.get(ref)!;
        const b = bodyBoundsOf(sym);
        const ox = grid(capX + MARGIN);
        const oy = grid(capY + MARGIN);
        placed.set(ref, {
          part: partByRef.get(ref)!,
          sym,
          x: ox,
          y: oy,
          body: { minX: ox + b.minX, minY: oy - b.maxY, maxX: ox + b.maxX, maxY: oy - b.minY },
          cellW: ceilU(b.maxX - b.minX) + 2 * MARGIN,
          cellH: ceilU(b.maxY - b.minY) + 2 * MARGIN,
        });
        capX += ceilU(b.maxX - b.minX) + 2 * MARGIN;
      }
      groupMaxY = capY + 2 * MARGIN + 6;
    }

    const memberRefs = [...members.map((m) => m.ref), ...capRefs];
    const cells = memberRefs.map((r) => placed.get(r)!);
    if (cells.length) {
      const minX = Math.min(...cells.map((c) => c.body.minX)) - MARGIN * U;
      const maxX = Math.max(...cells.map((c) => c.body.maxX)) + MARGIN * U;
      const minY = Math.min(...cells.map((c) => c.body.minY)) - (MARGIN + 4) * U;
      const maxY = Math.max(...cells.map((c) => c.body.maxY)) + (MARGIN + 2) * U;
      groupRects.push({ name: gname, x1: minX, y1: minY, x2: maxX, y2: maxY });
      groupX = Math.round(maxX / U) + GROUP_GAP;
    }
  }

  // ---------- stubs, power symbols, labels, wires (design D2/D6a) ----------
  const wires: PlacementModel['wires'] = [];
  const labels: PlacementModel['labels'] = [];
  const junctions: { x: number; y: number }[] = [];
  const extraSymbols: EmitSymbol[] = [];
  const libSymbols = new Map<string, string>();
  const pwrFlags: string[] = [];
  let wireIdx = new Map<string, number>();
  const addWire = (net: string, x1: number, y1: number, x2: number, y2: number): void => {
    if (x1 === x2 && y1 === y2) return;
    const i = wireIdx.get(net) ?? 0;
    wireIdx.set(net, i + 1);
    wires.push({ x1, y1, x2, y2, net, index: i });
  };

  let pwrSeq = 0;
  let flgSeq = 0;
  const endpointsOf = (net: IntentNet): { ref: string; pin: DraftPin; at: { x: number; y: number } }[] =>
    net.pins
      .map((ep) => {
        const m = /^([^.]+)\.(.+)$/.exec(ep)!;
        const pl = placed.get(m[1]!);
        const pin = symbols.get(m[1]!)?.pins.find((p) => p.number === m[2]);
        if (!pl || !pin) return null;
        return { ref: m[1]!, pin, at: pinAt(pl, pin) };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }) || a.pin.number.localeCompare(b.pin.number, undefined, { numeric: true }));

  // power-class nets: per-pin power symbols, rails up, grounds down; one
  // PWR_FLAG per net without a power_out driver (design D6a). The stub runs in
  // the pin's OUTWARD direction — a fixed vertical drop would land on the next
  // pin of a connector-style part (2 grid rows apart) and short two nets.
  // Horizontal stubs run 4 units so their symbol clears the 2-unit signal
  // stubs and label anchors of neighbouring rows.
  for (const net of [...powerNets].sort((a, b) => a.name.localeCompare(b.name))) {
    const cls = netClasses.get(net.name)!.cls;
    const src = powerSymbolSource(net.name, cls === 'ground' ? 'ground' : 'rail');
    libSymbols.set(src.libId, src.sourceText);
    const hasDriver = net.pins.some((ep) => pinLookup(ep)?.etype === 'power_out');
    const eps = endpointsOf(net);
    eps.forEach((ep, i) => {
      const o = outward(ep.pin);
      const len = o.dx !== 0 ? STUB + 2 : STUB;
      const stubEnd = { x: ep.at.x + o.dx * len * U, y: ep.at.y + o.dy * len * U };
      addWire(net.name, ep.at.x, ep.at.y, stubEnd.x, stubEnd.y);
      pwrSeq++;
      extraSymbols.push({
        ref: `#PWR${String(pwrSeq).padStart(2, '0')}`,
        libId: src.libId,
        value: net.name,
        footprint: '',
        at: { x: stubEnd.x, y: stubEnd.y, rot: 0 },
        refAt: { x: stubEnd.x, y: stubEnd.y },
        valueAt: { x: stubEnd.x, y: stubEnd.y + (cls === 'ground' ? 3.556 : -3.556) },
        hideRef: true,
        hideValue: true,
        pinNumbers: ['1'],
      });
      if (i === 0 && !hasDriver) {
        const flag = pwrFlagSource();
        libSymbols.set(flag.libId, flag.sourceText);
        flgSeq++;
        // the flag's pin sits exactly on the stub END so KiCad's connectivity
        // (which joins at wire endpoints) sees the power_out driver
        extraSymbols.push({
          ref: `#FLG${String(flgSeq).padStart(2, '0')}`,
          libId: flag.libId,
          value: 'PWR_FLAG',
          footprint: '',
          at: { x: stubEnd.x, y: stubEnd.y, rot: 0 },
          refAt: { x: stubEnd.x, y: stubEnd.y },
          valueAt: { x: stubEnd.x, y: stubEnd.y },
          hideRef: true,
          hideValue: true,
          pinNumbers: ['1'],
        });
        pwrFlags.push(net.name);
      }
    });
  }

  // signal nets: local nets wired, everything else labelled at a stub
  const bodies = [...placed.values()].map((p) => p.body);
  let wired = 0;
  let labelled = 0;
  for (const net of [...signalNets].sort((a, b) => a.name.localeCompare(b.name))) {
    const eps = endpointsOf(net);
    if (!eps.length) continue;
    const stubs = eps.map((ep) => {
      const o = outward(ep.pin);
      return { ep, end: { x: ep.at.x + o.dx * STUB * U, y: ep.at.y + o.dy * STUB * U }, o };
    });
    const groupsTouched = new Set(eps.map((e) => groupOf.get(e.ref)));
    const spanX = Math.max(...stubs.map((s) => s.end.x)) - Math.min(...stubs.map((s) => s.end.x));
    const spanY = Math.max(...stubs.map((s) => s.end.y)) - Math.min(...stubs.map((s) => s.end.y));
    let asWire = groupsTouched.size === 1 && eps.length <= MAX_WIRED_ENDPOINTS && Math.max(spanX, spanY) <= MAX_WIRE_SPAN;

    if (asWire) {
      // trunk-and-branch: a vertical trunk with horizontal branches. Several
      // deterministic trunk positions are tried in order (median stub x, right
      // of everything, left of everything); the first collision-free routing
      // wins, and if none exists the net falls back to labels — the engine may
      // never trip its own wire-through-symbol gate.
      const xs = stubs.map((s) => s.end.x).sort((a, b) => a - b);
      const ys = stubs.map((s) => s.end.y);
      const trunkCandidates = [
        grid(Math.round(xs[Math.floor(xs.length / 2)]! / U)),
        grid(Math.round(xs[xs.length - 1]! / U) + STUB),
        grid(Math.round(xs[0]! / U) - STUB),
      ];
      let routed = false;
      for (const trunkX of trunkCandidates) {
        const candidate: { x1: number; y1: number; x2: number; y2: number }[] = [];
        for (const s of stubs) {
          candidate.push({ x1: s.ep.at.x, y1: s.ep.at.y, x2: s.end.x, y2: s.end.y });
          if (s.end.x !== trunkX) candidate.push({ x1: s.end.x, y1: s.end.y, x2: trunkX, y2: s.end.y });
        }
        // the trunk is split at every branch meet: coincident wire ENDPOINTS
        // are what both KiCad and the geometric netlister join on
        const meetYs = [...new Set(ys)].sort((a, b) => a - b);
        for (let i = 1; i < meetYs.length; i++) {
          candidate.push({ x1: trunkX, y1: meetYs[i - 1]!, x2: trunkX, y2: meetYs[i]! });
        }
        if (candidate.some((c) => bodies.some((b) => segCrossesBody(c.x1, c.y1, c.x2, c.y2, b)))) continue;
        for (const c of candidate) addWire(net.name, c.x1, c.y1, c.x2, c.y2);
        // one label names the wired net (topmost-leftmost wire point): the net
        // stays identifiable to PINOUT/drift and to a reviewer without a
        // label-per-pin, matching hand-drafting practice
        const pts = candidate.flatMap((c) => [
          { x: c.x1, y: c.y1 },
          { x: c.x2, y: c.y2 },
        ]);
        pts.sort((a, b) => a.y - b.y || a.x - b.x);
        labels.push({ name: net.name, x: pts[0]!.x, y: pts[0]!.y, rot: 0 });
        wired++;
        if (eps.length > 2) {
          for (const s of stubs) {
            const meet = s.end.x === trunkX ? s.end : { x: trunkX, y: s.end.y };
            if (meet.y > Math.min(...ys) && meet.y < Math.max(...ys)) junctions.push(meet);
          }
        }
        routed = true;
        break;
      }
      if (!routed) asWire = false;
    }
    if (!asWire) {
      for (const s of stubs) {
        addWire(net.name, s.ep.at.x, s.ep.at.y, s.end.x, s.end.y);
        // labels are always horizontal (drafting standard): leftward pins read
        // outward to the left, everything else extends to the right
        labels.push({ name: net.name, x: s.end.x, y: s.end.y, rot: s.o.dx === -1 ? 180 : 0 });
        labelled++;
      }
    }
  }

  // junctions: any point where three or more wire ends meet
  const endCount = new Map<string, { x: number; y: number; n: number }>();
  for (const w of wires) {
    for (const [x, y] of [[w.x1, w.y1], [w.x2, w.y2]] as const) {
      const k = `${x},${y}`;
      const e = endCount.get(k) ?? { x, y, n: 0 };
      e.n++;
      endCount.set(k, e);
    }
  }
  for (const e of endCount.values()) if (e.n >= 3) junctions.push({ x: e.x, y: e.y });
  const uniqJunctions = [...new Map(junctions.map((j) => [`${j.x},${j.y}`, j])).values()];

  // no-connect markers (design D6a)
  const noConnects: { x: number; y: number }[] = [];
  for (const ep of intent.noConnect ?? []) {
    const m = /^([^.]+)\.(.+)$/.exec(ep);
    if (!m) continue;
    const pl = placed.get(m[1]!);
    const pin = symbols.get(m[1]!)?.pins.find((p) => p.number === m[2]);
    if (pl && pin) noConnects.push(pinAt(pl, pin));
  }

  // ---------- member symbols with collision-free text slots ----------
  const emitSymbols: EmitSymbol[] = [];
  for (const [ref, pl] of [...placed.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
    const pinSides = new Set(pl.sym.pins.map((p) => {
      const o = outward(p);
      return o.dx === -1 ? 'left' : o.dx === 1 ? 'right' : o.dy === -1 ? 'top' : 'bottom';
    }));
    const cy = (pl.body.minY + pl.body.maxY) / 2;
    const cx = (pl.body.minX + pl.body.maxX) / 2;
    const textW = Math.max(ref.length, pl.part.value.length) * 0.8 * 1.27;
    let refAt: { x: number; y: number };
    let valueAt: { x: number; y: number };
    if (!pinSides.has('top')) {
      refAt = { x: cx, y: pl.body.minY - 2.54 };
      valueAt = { x: cx, y: pl.body.minY - 2.54 + (pinSides.has('bottom') ? -2.54 : (pl.body.maxY - pl.body.minY) + 5.08) };
      if (pinSides.has('bottom')) {
        valueAt = { x: cx, y: pl.body.minY - 5.08 };
      } else {
        valueAt = { x: cx, y: pl.body.maxY + 2.54 };
      }
    } else {
      refAt = { x: pl.body.maxX + textW / 2 + 1.27, y: cy - 1.27 };
      valueAt = { x: pl.body.maxX + textW / 2 + 1.27, y: cy + 1.27 };
    }
    emitSymbols.push({
      ref,
      libId: pl.sym.libId,
      value: pl.part.value,
      footprint: pl.part.footprint ?? '',
      at: { x: pl.x, y: pl.y, rot: 0 },
      refAt,
      valueAt,
      pinNumbers: pl.sym.pins.map((p) => p.number),
    });
    libSymbols.set(pl.sym.libId, pl.sym.sourceText);
  }

  // ---------- sheet: content-derived paper, balanced placement ----------
  const allX = [...groupRects.map((r) => r.x1), ...groupRects.map((r) => r.x2)];
  const allY = [...groupRects.map((r) => r.y1), ...groupRects.map((r) => r.y2)];
  const contentW = allX.length ? Math.max(...allX) - Math.min(...allX) : 0;
  const contentH = allY.length ? Math.max(...allY) - Math.min(...allY) : 0;
  const paperName = intent.hints?.paper;
  const paper =
    (paperName ? PAPERS.find((p) => p.name === paperName) : undefined) ??
    PAPERS.find((p) => contentW <= p.w - 2 * FRAME && contentH <= p.h - 2 * FRAME - TITLE_STRIP) ??
    PAPERS[PAPERS.length - 1]!;
  if (paperName && !PAPERS.some((p) => p.name === paperName)) notes.push(`paper hint "${paperName}" is not a standard size; using ${paper.name}`);

  // offset so content sits centered in the usable area (whitespace balance,
  // design D11), snapped to the grid so origins stay grid-true
  const minX = allX.length ? Math.min(...allX) : 0;
  const minY = allY.length ? Math.min(...allY) : 0;
  const availW = paper.w - 2 * FRAME;
  const availH = paper.h - 2 * FRAME - TITLE_STRIP;
  const dx = grid(Math.round((FRAME + Math.max(0, (availW - contentW) / 2) - minX) / U));
  const dy = grid(Math.round((FRAME + 4 * U + Math.max(0, (availH - contentH) / 2) - minY) / U));
  const shift = <T extends { x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }>(o: T): T => {
    if (o.x !== undefined) o.x += dx;
    if (o.y !== undefined) o.y += dy;
    if (o.x1 !== undefined) o.x1 += dx;
    if (o.y1 !== undefined) o.y1 += dy;
    if (o.x2 !== undefined) o.x2 += dx;
    if (o.y2 !== undefined) o.y2 += dy;
    return o;
  };
  for (const s of [...emitSymbols, ...extraSymbols]) {
    s.at.x += dx;
    s.at.y += dy;
    shift(s.refAt);
    shift(s.valueAt);
  }
  wires.forEach(shift);
  labels.forEach(shift);
  uniqJunctions.forEach(shift);
  noConnects.forEach(shift);
  groupRects.forEach(shift);

  const model: PlacementModel = {
    projectName,
    paper: paper.name,
    title: { title: projectName, date: today, rev: 'A' },
    libSymbols: [...libSymbols.entries()].map(([libId, sourceText]) => ({ libId, sourceText })),
    symbols: [...emitSymbols, ...extraSymbols],
    wires,
    junctions: uniqJunctions,
    labels,
    noConnects,
    rectangles: groupRects.map((r) => ({ x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2, stroke: 'solid' as const, name: r.name })),
    captions: groupRects.map((r) => ({ text: r.name, x: r.x1 + 2, y: r.y1 + 2, name: r.name })),
  };

  const report: DraftReport = {
    groups: groupNames.map((g) => ({
      name: g,
      members: [...groupOf.entries()].filter(([, gg]) => gg === g).map(([r]) => r).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    })),
    netClasses: [...netClasses.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, c]) => ({ name, class: c.cls, overridden: c.overridden })),
    wireCount: wires.length,
    labelCount: labels.length,
    pwrFlags,
    noConnects: noConnects.length,
    paper: paper.name,
    notes,
  };
  return { model, report };
}