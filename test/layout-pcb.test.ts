import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { parseBoard, readBoard, footprintLocalToBoard } from '../src/kicad/pcb.js';
import { FIXTURE, REFERENCE_BOARD } from './helpers.js';

/** KiCad 10 writes net names inline on every object and keeps no id table. */
const KICAD10 = `(kicad_pcb
  (version 20260206)
  (generator "pcbnew")
  (generator_version "10.0")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user) (31 "F.CrtYd" user))
  (net 0 "")
  (gr_rect (start 0 0) (end 30 20) (stroke (width 0.1) (type default)) (layer "Edge.Cuts"))
  (footprint "Device:R"
    (layer "F.Cu")
    (at 10 10 90)
    (property "Reference" "R1" (at 0 0 0) (layer "F.SilkS"))
    (property "Value" "10k" (at 0 0 0) (layer "F.SilkS"))
    (fp_rect (start -2 -1) (end 2 1) (stroke (width 0.05) (type default)) (layer "F.CrtYd"))
    (pad "1" smd rect (at -1.5 0) (size 1 1) (layers "F.Cu" "F.Mask") (net "VCC"))
    (pad "2" smd rect (at 1.5 0) (size 1 1) (layers "F.Cu" "F.Mask") (net "GND"))
  )
  (segment (start 10 11.5) (end 20 11.5) (width 0.4) (layer "F.Cu") (net "VCC"))
  (via (at 20 11.5) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net "VCC"))
  (zone (net "GND") (layer "B.Cu") (filled_polygon (layer "B.Cu") (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10))))
)`;

/** KiCad 8/9 writes `(net 3 "X")` on pads and a bare `(net 3)` elsewhere. */
const KICAD8 = `(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (generator_version "8.0")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user) (47 "F.CrtYd" user))
  (net 0 "")
  (net 1 "GND")
  (net 2 "VCC")
  (gr_rect (start 0 0) (end 30 20) (stroke (width 0.1) (type default)) (layer "Edge.Cuts"))
  (footprint "Device:R"
    (layer "F.Cu")
    (at 10 10 90)
    (property "Reference" "R1" (at 0 0 0) (layer "F.SilkS"))
    (property "Value" "10k" (at 0 0 0) (layer "F.SilkS"))
    (fp_rect (start -2 -1) (end 2 1) (stroke (width 0.05) (type default)) (layer "F.CrtYd"))
    (pad "1" smd rect (at -1.5 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 2 "VCC"))
    (pad "2" smd rect (at 1.5 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "GND"))
  )
  (segment (start 10 11.5) (end 20 11.5) (width 0.4) (layer "F.Cu") (net 2))
  (via (at 20 11.5) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 2))
  (zone (net 1) (net_name "GND") (layer "B.Cu") (filled_polygon (layer "B.Cu") (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10))))
)`;

describe('kicad_pcb reader', () => {
  it('reads the KiCad 10 named-net encoding', () => {
    const b = parseBoard(KICAD10, 'k10.kicad_pcb');
    expect(b.generatorVersion).toBe('10.0');
    expect(b.footprints[0]!.pads.map((p) => p.net)).toEqual(['VCC', 'GND']);
    expect(b.segments[0]!.net).toBe('VCC');
    expect(b.vias[0]!.net).toBe('VCC');
    expect(b.zones[0]!.net).toBe('GND');
    // KiCad 10's net table holds net 0 alone, so the board's net names must
    // come from the objects, not the table (constraint-to-net matching
    // resolves against them).
    expect(b.netNames.sort()).toEqual(['GND', 'VCC']);
  });

  it('resolves the KiCad 8 numeric-net encoding through the board net table', () => {
    const b = parseBoard(KICAD8, 'k8.kicad_pcb');
    expect(b.netNames.sort()).toEqual(['GND', 'VCC']);
    // The pads carry id + name; the segment, via and zone carry the bare id.
    expect(b.footprints[0]!.pads.map((p) => p.net)).toEqual(['VCC', 'GND']);
    expect(b.segments[0]!.net).toBe('VCC');
    expect(b.vias[0]!.net).toBe('VCC');
    expect(b.zones[0]!.net).toBe('GND');
  });

  it('reads both encodings to the same geometry', () => {
    const a = parseBoard(KICAD10);
    const b = parseBoard(KICAD8);
    expect(a.footprints[0]!.pads.map((p) => [p.x, p.y])).toEqual(b.footprints[0]!.pads.map((p) => [p.x, p.y]));
    expect(a.outline).toEqual(b.outline);
    expect(a.zones[0]!.filledAreaMm2).toEqual(b.zones[0]!.filledAreaMm2);
  });

  it('applies the footprint rotation to pad positions', () => {
    const b = parseBoard(KICAD10);
    // R1 sits at (10,10) rotated 90 degrees, so its pads move onto the Y axis.
    expect(b.footprints[0]!.pads.map((p) => [p.x, p.y])).toEqual([
      [10, 11.5],
      [10, 8.5],
    ]);
    expect(footprintLocalToBoard({ x: 0, y: 0, rot: 180 }, { x: 25, y: 0 })).toEqual({ x: -25, y: 0 });
  });

  it('reads courtyards, zone fill area and the Edge.Cuts outline', () => {
    const b = parseBoard(KICAD10);
    expect(b.outline).toEqual({ minX: 0, minY: 0, maxX: 30, maxY: 20 });
    expect(b.footprints[0]!.courtyard).toEqual({ minX: 9, minY: 8, maxX: 11, maxY: 12 });
    expect(b.zones[0]!.filledAreaMm2).toBe(100);
  });

  it('reads an empty scaffold cleanly: outline, no footprints, no error', async () => {
    const b = await readBoard(path.join(FIXTURE, 'hardware', 'open-key.kicad_pcb'));
    expect(b.footprints).toEqual([]);
    expect(b.segments).toEqual([]);
    expect(b.zones).toEqual([]);
    expect(b.outline).toEqual({ minX: 100, minY: 100, maxX: 140, maxY: 130 });
  });

  it('reads the committed reference board', async () => {
    const b = await readBoard(REFERENCE_BOARD);
    expect(b.footprints.map((f) => f.ref)).toEqual(['U1', 'C1', 'C2', 'J1', 'R1', 'R2', 'H1', 'H2']);
    expect(b.segments).toHaveLength(8);
    expect(b.vias).toHaveLength(1);
    expect(b.zones).toHaveLength(1);
    // `*.Cu` on a through-hole pad expands against the board's own copper stack.
    const j1 = b.footprints.find((f) => f.ref === 'J1')!;
    expect(j1.pads[0]!.layers.sort()).toEqual(['B.Cu', 'F.Cu']);
  });

  it('refuses a file that is not a board', () => {
    expect(() => parseBoard('(kicad_sch (version 20240108))', 'x.kicad_sch')).toThrow(/not a KiCad board file/);
  });
});
