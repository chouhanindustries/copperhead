import { describe, expect, it } from 'vitest';
import { trackRepairProgress, type RepairProgress } from '../src/agent/tools.js';
import type { CheckReport, Violation } from '../src/kicad/report.js';

const violation = (index: number): Violation => ({
  severity: 'error',
  type: `test-${index}`,
  description: `test violation ${index}`,
  items: [],
});

const report = (source: 'erc' | 'drc', count: number): CheckReport => ({
  ok: count === 0,
  source,
  violations: Array.from({ length: count }, (_, index) => violation(index)),
});

describe('repair progress budget', () => {
  it('does not spend the budget while ERC violations are improving', () => {
    const progress: RepairProgress = {};
    const observed = [10, 5, 7, 6, 5, 6].map((count) =>
      trackRepairProgress(progress, report('erc', count)),
    );

    // This is the exact shape of the first live create-stage failure: four
    // improving reports were previously counted as four spent repair cycles.
    expect(observed).toEqual([0, 0, 1, 0, 0, 1]);
    expect(Math.max(...observed)).toBe(1);
  });

  it('exhausts a five-cycle budget on six consecutive non-improving checks', () => {
    const progress: RepairProgress = {};
    const observed = Array.from({ length: 7 }, () =>
      trackRepairProgress(progress, report('erc', 3)),
    );

    expect(observed).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(observed.at(-1)).toBeGreaterThan(5);
  });

  it('resets on clean and tracks ERC and DRC independently', () => {
    const progress: RepairProgress = {};
    expect(trackRepairProgress(progress, report('erc', 4))).toBe(0);
    expect(trackRepairProgress(progress, report('erc', 4))).toBe(1);
    expect(trackRepairProgress(progress, report('drc', 8))).toBe(0);
    expect(trackRepairProgress(progress, report('erc', 0))).toBe(0);
    expect(progress.erc).toBeUndefined();
    expect(progress.drc).toEqual({ violations: 8, nonImproving: 0 });
    expect(trackRepairProgress(progress, report('erc', 4))).toBe(0);
  });
});
