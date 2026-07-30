import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parseBoard } from '../src/kicad/pcb.js';
import { computeLayoutMetrics, type LayoutMetrics } from '../src/kicad/layout-metrics.js';
import { REFERENCE_BOARD, REFERENCE_CONSTRAINTS } from './helpers.js';

/**
 * Mutation testing for the layout scorer (design D10). Take a good board,
 * degrade it four ways, require the score to fall every time. A scorer that
 * cannot separate the mutants from the original is not measuring layout
 * quality, and this is also the regression test that catches a scorer (or a
 * future placer) change that quietly makes layouts worse.
 *
 * Mutations are anchored exact-match text replaces on the fixture source, the
 * same way copperhead itself edits KiCad files: nothing here serializes a board.
 */

interface Mutation {
  name: string;
  /** What the degradation is supposed to show up as, beyond a lower score. */
  expect: (mutated: LayoutMetrics, original: LayoutMetrics) => void;
  apply: (text: string) => string;
}

const replaceOnce = (text: string, from: string, to: string): string => {
  const at = text.indexOf(from);
  if (at === -1) throw new Error(`mutation anchor not found: ${from}`);
  if (text.indexOf(from, at + 1) !== -1) throw new Error(`mutation anchor is not unique: ${from}`);
  return text.slice(0, at) + to + text.slice(at + from.length);
};

const MUTATIONS: Mutation[] = [
  {
    name: 'every decoupling cap moves 15 mm from the part it bypasses',
    apply: (t) => replaceOnce(replaceOnce(t, '(at 117.5 110.5)', '(at 117.5 125.5)'), '(at 117.5 118.5)', '(at 117.5 133.5)'),
    expect: (m) => {
      const row = m.hard.find((r) => r.key === 'power.decoupling_distance_mm')!;
      expect(row.status).toBe('fail');
      expect(m.soft.unroutedNetNames).toContain('+5V');
    },
  },
  {
    name: 'the power net is narrowed to 0.25 mm',
    apply: (t) => t.replace(/\(width 1\.5\)/g, '(width 0.25)'),
    expect: (m, original) => {
      const row = m.hard.find((r) => r.key === 'mech.load_trace_width_mm')!;
      expect(row.status).toBe('fail');
      expect(row.actual).toBe('0.25 mm');
      // Nothing moved, so this mutation is visible only through the hard table.
      expect(m.soft.routedNetFraction).toBe(original.soft.routedNetFraction);
    },
  },
  {
    name: 'placements are shuffled within the outline',
    apply: (t) =>
      replaceOnce(
        replaceOnce(replaceOnce(t, '(at 120 115)', '(at 145 128)'), '(at 135 113.73)', '(at 110 132)'),
        '(at 135 118.27)',
        '(at 128 133)',
      ),
    expect: (m) => {
      expect(m.soft.unroutedNetNames).toEqual(expect.arrayContaining(['+5V', 'SIG1', 'SIG2']));
      expect(m.soft.offBoardFootprints).toBe(0);
    },
  },
  {
    name: 'the ground zone is deleted',
    apply: (t) => t.slice(0, t.indexOf('  (zone')) + ')\n',
    expect: (m) => {
      expect(m.soft.zones).toBe(0);
      expect(m.soft.unroutedNetNames).toContain('GND');
      expect(m.hard.find((r) => r.key === 'thermal.copper_area_mm2')!.status).toBe('fail');
    },
  },
];

describe('layout scorer mutation suite', () => {
  let source = '';
  let original: LayoutMetrics;

  beforeAll(async () => {
    source = await readFile(REFERENCE_BOARD, 'utf8');
    original = computeLayoutMetrics(parseBoard(source, 'reference-board.kicad_pcb'), REFERENCE_CONSTRAINTS);
  });

  it('scores the undegraded reference board with every hard constraint passing', () => {
    expect(original.hard.every((r) => r.status === 'pass')).toBe(true);
    expect(original.score).toBe(93.4);
  });

  for (const mutation of MUTATIONS) {
    it(`scores strictly lower when ${mutation.name}`, () => {
      const mutated = computeLayoutMetrics(
        parseBoard(mutation.apply(source), 'mutant.kicad_pcb'),
        REFERENCE_CONSTRAINTS,
      );
      mutation.expect(mutated, original);
      expect(mutated.score).toBeLessThan(original.score);
    });
  }

  it('leaves the fixture on disk untouched', async () => {
    expect(await readFile(REFERENCE_BOARD, 'utf8')).toBe(source);
  });
});
