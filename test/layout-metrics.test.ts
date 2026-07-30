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
