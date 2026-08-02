import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseBoard, readBoard } from '../src/kicad/pcb.js';
import { computeLayoutMetrics } from '../src/kicad/layout-metrics.js';
import { renderDraftQuality, upsertDraftQuality, formatLayoutMetrics } from '../src/kicad/layout-report.js';
import { FIXTURE, REFERENCE_BOARD, REFERENCE_CONSTRAINTS } from './helpers.js';

const UNROUTED_PAIR = `(kicad_pcb
  (version 20240108)
  (generator "test")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "")
  (net 1 "ALPHA")
  (net 2 "BETA")
  (gr_rect (start 0 0) (end 30 20) (stroke (width 0.1) (type default)) (layer "Edge.Cuts"))
  (footprint "Device:R" (layer "F.Cu") (at 5 5)
    (property "Reference" "R1" (at 0 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "ALPHA"))
  )
  (footprint "Device:R" (layer "F.Cu") (at 25 5)
    (property "Reference" "R2" (at 0 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "ALPHA"))
  )
  (footprint "Device:R" (layer "F.Cu") (at 5 15)
    (property "Reference" "R3" (at 0 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 2 "BETA"))
  )
  (footprint "Device:R" (layer "F.Cu") (at 25 15)
    (property "Reference" "R4" (at 0 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 2 "BETA"))
  )
)`;

describe('computeLayoutMetrics: soft scorecard', () => {
  it('scores the reference board as fully routed', async () => {
    const m = computeLayoutMetrics(await readBoard(REFERENCE_BOARD), REFERENCE_CONSTRAINTS);
    expect(m.soft.footprints).toBe(8);
    expect(m.soft.routableNets).toBe(4);
    expect(m.soft.routedNets).toBe(4);
    expect(m.soft.routedNetFraction).toBe(1);
    expect(m.soft.unroutedNetNames).toEqual([]);
    expect(m.soft.courtyardOverlaps).toBe(0);
    expect(m.soft.offBoardFootprints).toBe(0);
    expect(m.soft.boardAreaMm2).toBe(2400);
    expect(m.score).toBeGreaterThan(85);
  });

  it('names every unrouted net', () => {
    const m = computeLayoutMetrics(parseBoard(UNROUTED_PAIR, 'unrouted.kicad_pcb'), {});
    expect(m.soft.routedNetFraction).toBeLessThan(1);
    expect(m.soft.unroutedNetNames).toEqual(['ALPHA', 'BETA']);
  });

  it('does not let an empty board outscore a routed one', async () => {
    const empty = computeLayoutMetrics(await readBoard(path.join(FIXTURE, 'hardware', 'open-key.kicad_pcb')), {});
    const routed = computeLayoutMetrics(await readBoard(REFERENCE_BOARD), REFERENCE_CONSTRAINTS);
    expect(empty.soft.footprints).toBe(0);
    // An empty scaffold banks no placement or routing points: the terms it
    // "passes" by having nothing on it are zeroed, not awarded.
    expect(empty.terms.find((t) => t.name === 'Courtyard clearance')!.points).toBe(0);
    expect(empty.terms.find((t) => t.name === 'On-board placement')!.points).toBe(0);
    expect(empty.terms.find((t) => t.name === 'Placement density')!.points).toBe(0);
    // Nothing placed, nothing routed: strictly below a placed-but-unrouted
    // board, which is strictly below a routed one.
    const placedOnly = computeLayoutMetrics(parseBoard(UNROUTED_PAIR), {});
    expect(empty.score).toBeLessThan(placedOnly.score);
    expect(placedOnly.score).toBeLessThan(routed.score);
  });

  it('credits a pour as copper, and stops crediting it when the pour is gone', async () => {
    const text = await readFile(REFERENCE_BOARD, 'utf8');
    const withZone = computeLayoutMetrics(parseBoard(text), {});
    const zoneStart = text.indexOf('  (zone');
    const withoutZone = computeLayoutMetrics(parseBoard(text.slice(0, zoneStart) + ')\n'), {});
    expect(withZone.soft.unroutedNetNames).toEqual([]);
    expect(withoutZone.soft.unroutedNetNames).toEqual(['GND']);
  });
});

/** A GND pour and two pads, in the KiCad 10 encoding: net names inline on
 *  every object, the net table holding net 0 alone. */
const KICAD10_COPPER = `(kicad_pcb
  (version 20260206)
  (generator "pcbnew")
  (generator_version "10.0")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (net 0 "")
  (gr_rect (start 0 0) (end 30 20) (stroke (width 0.1) (type default)) (layer "Edge.Cuts"))
  (footprint "Device:R" (layer "F.Cu") (at 5 10)
    (property "Reference" "R1" (at 0 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "GND"))
  )
  (footprint "Device:R" (layer "F.Cu") (at 25 10)
    (property "Reference" "R2" (at 0 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "GND"))
  )
  (zone (net "GND") (layer "B.Cu") (filled_polygon (layer "B.Cu") (pts (xy 0 0) (xy 20 0) (xy 20 20) (xy 0 20))))
)`;

/** A mounting hole written without a pad, next to real copper. */
const PADLESS_HOLE = `(kicad_pcb
  (version 20240108)
  (generator "test")
  (layers (0 "F.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "")
  (net 1 "SIG")
  (gr_rect (start 0 0) (end 30 20) (stroke (width 0.1) (type default)) (layer "Edge.Cuts"))
  (footprint "MountingHole:MountingHole_3.2mm_M3" (layer "F.Cu") (at 5 10)
    (property "Reference" "H1" (at 0 0 0) (layer "F.SilkS"))
  )
  (footprint "Device:R" (layer "F.Cu") (at 20 10)
    (property "Reference" "R1" (at 0 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (net 1 "SIG"))
    (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (net 1 "SIG"))
  )
  (segment (start 19 10) (end 21 10) (width 0.5) (layer "F.Cu") (net 1))
)`;

describe('computeLayoutMetrics: hard table', () => {
  it('produces one traceable row per matching constraint key', async () => {
    const m = computeLayoutMetrics(await readBoard(REFERENCE_BOARD), REFERENCE_CONSTRAINTS);
    expect(m.hard.map((r) => r.key).sort()).toEqual(Object.keys(REFERENCE_CONSTRAINTS).sort());
    for (const row of m.hard) {
      expect(row.status).toBe('pass');
      expect(REFERENCE_CONSTRAINTS[row.key]).toBeDefined();
      expect(row.expected).not.toBe('');
      expect(row.actual).not.toBe('');
    }
  });

  it('fails a width row against the key it came from, with the measured value', async () => {
    const text = (await readFile(REFERENCE_BOARD, 'utf8')).replace(/\(width 1\.5\)/g, '(width 0.25)');
    const m = computeLayoutMetrics(parseBoard(text), {
      'mech.load_trace_width_mm': { min: 1.5, source: 'docs/SPEC.md', affects: ['layout'] },
    });
    expect(m.hard).toHaveLength(1);
    expect(m.hard[0]).toMatchObject({
      key: 'mech.load_trace_width_mm',
      expected: '>= 1.5 mm',
      actual: '0.25 mm',
      status: 'fail',
    });
  });

  it('invents no rows for an empty registry, and none for unmatched keys', async () => {
    const board = await readBoard(REFERENCE_BOARD);
    expect(computeLayoutMetrics(board, {}).hard).toEqual([]);
    const unmatched = computeLayoutMetrics(board, {
      'power.sleep_current_uA': { max: 10, source: 'docs/SPEC.md', affects: ['schematic'] },
    });
    expect(unmatched.hard).toEqual([]);
    // and the soft scorecard is still produced
    expect(unmatched.soft.footprints).toBe(8);
    expect(unmatched.score).toBeGreaterThan(0);
  });

  it('reports n/a rather than a verdict when the board cannot answer the constraint', async () => {
    const empty = await readBoard(path.join(FIXTURE, 'hardware', 'open-key.kicad_pcb'));
    const m = computeLayoutMetrics(empty, REFERENCE_CONSTRAINTS);
    const decided = m.hard.filter((r) => r.status !== 'n/a').map((r) => r.key);
    // Only the outline is measurable on a board with nothing on it.
    expect(decided).toEqual(['mech.board_outline_mm']);
    for (const row of m.hard.filter((r) => r.status === 'n/a')) expect(row.note).toBeTruthy();
    // The empty scaffold keeps the exclusion behaviour: its n/a rows do not
    // forfeit the hard term (the placement and routing terms hold it down).
    expect(m.terms.find((t) => t.name === 'Hard constraints')!.points).toBe(20);
  });

  it('forfeits the hard term when a populated board cannot answer a constraint', () => {
    const m = computeLayoutMetrics(parseBoard(UNROUTED_PAIR, 'unrouted.kicad_pcb'), {
      'power.decoupling_distance_mm': { max: 5, source: 'docs/SPEC.md', affects: ['layout'] },
    });
    expect(m.hard).toHaveLength(1);
    expect(m.hard[0]!.status).toBe('n/a');
    const term = m.terms.find((t) => t.name === 'Hard constraints')!;
    expect(term.points).toBe(0);
    expect(term.detail).toContain('forfeit');
  });

  it('resolves a constraint-named net on a KiCad 10 board with no net table', () => {
    // KiCad 10 keeps net 0 alone in the table; the names live on the objects.
    // The copper-area row must still find GND rather than degrade to n/a.
    const m = computeLayoutMetrics(parseBoard(KICAD10_COPPER, 'k10.kicad_pcb'), {
      'thermal.copper_area_mm2': { min: 300, value: 'GND', source: 'docs/SPEC.md', affects: ['layout'] },
    });
    expect(m.hard).toHaveLength(1);
    expect(m.hard[0]).toMatchObject({
      key: 'thermal.copper_area_mm2',
      metric: 'Copper area on GND',
      status: 'pass',
    });
  });

  it('bounds a range constraint from both sides', async () => {
    const board = await readBoard(REFERENCE_BOARD);
    const pass = computeLayoutMetrics(board, {
      'mech.load_trace_width_mm': { min: 1, max: 2, source: 'docs/SPEC.md', affects: ['layout'] },
    });
    expect(pass.hard[0]).toMatchObject({ expected: '1 to 2 mm', actual: '1.5 mm', status: 'pass' });
    const fail = computeLayoutMetrics(board, {
      'mech.load_trace_width_mm': { min: 0.1, max: 1, source: 'docs/SPEC.md', affects: ['layout'] },
    });
    expect(fail.hard[0]).toMatchObject({ expected: '0.1 to 1 mm', status: 'fail' });
  });

  it('reports n/a when a matched constraint records no bound', async () => {
    const m = computeLayoutMetrics(await readBoard(REFERENCE_BOARD), {
      'power.decoupling_distance_mm': { source: 'docs/SPEC.md', affects: ['layout'] },
    });
    // The measurement itself succeeds (the note names the worst cap), but with
    // no recorded min/max there is no verdict to reach.
    expect(m.hard[0]).toMatchObject({ status: 'n/a', expected: 'no numeric bound recorded' });
    expect(m.hard[0]!.actual).toMatch(/mm$/);
  });

  it('checks a max-only outline constraint against the largest dimension', async () => {
    const board = await readBoard(REFERENCE_BOARD);
    const pass = computeLayoutMetrics(board, {
      'mech.board_outline_mm': { max: 70, source: 'docs/SPEC.md', affects: ['layout'] },
    });
    expect(pass.hard[0]).toMatchObject({ expected: 'largest dimension <= 70 mm', status: 'pass' });
    const fail = computeLayoutMetrics(board, {
      'mech.board_outline_mm': { max: 50, source: 'docs/SPEC.md', affects: ['layout'] },
    });
    expect(fail.hard[0]!.status).toBe('fail');
  });

  it('anchors mounting-hole clearance at the footprint origin when the hole has no pad', () => {
    const m = computeLayoutMetrics(parseBoard(PADLESS_HOLE, 'padless.kicad_pcb'), {
      'mech.mounting_hole_clearance_mm': { min: 2, source: 'docs/SPEC.md', affects: ['layout'] },
    });
    // Nearest copper to H1 at (5,10) is R1's pad 1 at (19,10): 14 mm minus
    // half the 1 mm pad extent, with no pad radius on the hole side.
    expect(m.hard[0]).toMatchObject({ status: 'pass', actual: '13.5 mm' });
    expect(m.hard[0]!.note).toContain('1 mounting hole(s)');
  });
});

describe('draft-quality rendering', () => {
  const sample = async () =>
    computeLayoutMetrics(
      { ...(await readBoard(REFERENCE_BOARD)), filePath: 'hardware/board.kicad_pcb' },
      REFERENCE_CONSTRAINTS,
    );

  it('renders the constraint keys, the statuses and the score', async () => {
    const body = renderDraftQuality(await sample());
    expect(body).toContain('Layout score: 93.4 / 100');
    for (const key of Object.keys(REFERENCE_CONSTRAINTS)) expect(body).toContain(`\`${key}\``);
    expect(body).toContain('### Hard constraints');
    expect(body).toContain('### Soft scorecard');
    expect(body).toContain('| Routed nets | 4 of 4 (100.0%) |');
  });

  it('says so plainly when there is no hard table', async () => {
    const body = renderDraftQuality(computeLayoutMetrics(await readBoard(REFERENCE_BOARD), {}));
    expect(body).toContain('no hard table');
    expect(body).not.toContain('| Constraint key |');
  });

  it('upserts the section and preserves prose below the marker', async () => {
    const doc = [
      '# Layout notes',
      '',
      '## Stackup',
      '',
      'Two layers, 1.6 mm.',
      '',
      '## Draft quality',
      '',
      'The LDR placement is a guess and a human should redo it.',
      '',
      '## Next steps',
      '',
      'Order a prototype.',
      '',
    ].join('\n');
    const once = upsertDraftQuality(doc, renderDraftQuality(await sample()));
    // First pass: the model's hand-written body moves below the marker.
    expect(once).toContain('The LDR placement is a guess and a human should redo it.');
    expect(once.indexOf('copperhead:notes')).toBeLessThan(once.indexOf('The LDR placement is a guess'));
    // Sections either side are untouched, and the section stays in place.
    expect(once).toContain('Two layers, 1.6 mm.');
    expect(once).toContain('## Next steps');
    expect(once.indexOf('## Draft quality')).toBeLessThan(once.indexOf('## Next steps'));

    // Second pass: the generated block is refreshed, the prose is not.
    const narrowed = computeLayoutMetrics(
      parseBoard((await readFile(REFERENCE_BOARD, 'utf8')).replace(/\(width 1\.5\)/g, '(width 0.25)')),
      REFERENCE_CONSTRAINTS,
    );
    const twice = upsertDraftQuality(once, renderDraftQuality(narrowed));
    expect(twice).toContain('The LDR placement is a guess and a human should redo it.');
    expect(twice).toContain('| 0.25 mm | fail |');
    expect(twice).not.toContain('Layout score: 93.4 / 100');
    expect(twice.match(/copperhead:notes/g)).toHaveLength(1);
    expect(twice.match(/^## Draft quality$/gm)).toHaveLength(1);
  });

  it('preserves blank-line runs outside the generated block', async () => {
    // Regression: the blank-line normalization used to run over the whole
    // document, collapsing deliberate blank runs (e.g. inside fenced code
    // blocks) in other sections and in the notes on every regeneration.
    const doc = [
      '# Layout notes',
      '',
      '## Firmware handshake',
      '',
      '```c',
      'int a;',
      '',
      '',
      'int b;',
      '```',
      '',
      '## Draft quality',
      '',
      'Keep this judgement.',
      '',
      '```text',
      'x',
      '',
      '',
      'y',
      '```',
      '',
    ].join('\n');
    const once = upsertDraftQuality(doc, renderDraftQuality(await sample()));
    expect(once).toContain('int a;\n\n\nint b;');
    expect(once).toContain('x\n\n\ny');
    const twice = upsertDraftQuality(once, renderDraftQuality(await sample()));
    expect(twice).toContain('int a;\n\n\nint b;');
    expect(twice).toContain('x\n\n\ny');
    expect(twice).toContain('Keep this judgement.');
  });

  it('appends the section when the document does not have one', async () => {
    const out = upsertDraftQuality('# Layout notes\n\nNothing yet.\n', renderDraftQuality(await sample()));
    expect(out).toContain('# Layout notes');
    expect(out).toContain('## Draft quality');
    expect(out.endsWith('\n')).toBe(true);
    expect(out).not.toMatch(/\n\n\n/);
  });

  it('formats the agent-facing text with every hard row and the unrouted nets', async () => {
    const text = formatLayoutMetrics(await sample());
    expect(text).toMatch(/^layout score: 93\.4\/100 for hardware\/board\.kicad_pcb$/m);
    expect(text).toContain('[pass] mech.load_trace_width_mm');
    expect(text).toContain('unrouted nets: none');
  });
});
