import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  summarizeTurnCost,
  editPressureOf,
  addEditPressure,
  readRunTurnCost,
  EMPTY_EDIT_PRESSURE,
} from '../src/agent/turn-metrics.js';

const RUNS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'runs');

/**
 * The per-turn output of run `2026-07-29T18-02-20-554Z` — the 65m46s schematic
 * stage that emitted 170,920 output tokens across 40 turns and ended with
 * nothing committed. Copied verbatim from issue #145 so the summarizer is
 * pinned to figures that were computed independently of this code.
 */
const ISSUE_145_TURNS = [
  63, 254, 43629, 17777, 28830, 32243, 2530, 898, 481, 1986, 29672, 1268, 909, 1388, 2324, 177, 293, 142, 128, 135,
  177, 167, 201, 82, 82, 82, 89, 82, 82, 85, 81, 82, 89, 82, 86, 951, 2554, 23, 23, 693,
];

const rows = (outs: number[]): { turn: number; in: number; out: number }[] =>
  outs.map((out, i) => ({ turn: i + 1, in: 0, out }));

describe('turn-cost concentration (issue #145 §A)', () => {
  it('reproduces the published figures for the 65-minute schematic run', () => {
    const s = summarizeTurnCost(rows(ISSUE_145_TURNS));
    expect(s.turns).toBe(40);
    expect(s.p50TurnOut).toBe(177);
    expect(s.maxTurnOut).toBe(43629);
    expect(s.p95TurnOut).toBe(29672);
    // The headline number: 5 of 40 turns carried 89% of the run's output.
    expect(Number(s.top5TurnShare.toFixed(2))).toBe(0.89);
    // No `ms` on these rows (the array predates per-turn wall timing).
    expect(s.slowestTurnMs).toBeNull();
  });

  it('zeroes an empty run instead of producing NaN', () => {
    const s = summarizeTurnCost([]);
    expect(s).toEqual({
      turns: 0,
      p50TurnOut: 0,
      p95TurnOut: 0,
      maxTurnOut: 0,
      top5TurnShare: 0,
      slowestTurnMs: null,
    });
  });

  it('a run that emitted nothing is 0% concentrated, not NaN', () => {
    // Run 2026-07-29T19-08-45-912Z: 40 turns, 0 output tokens, a full cache
    // replay of a losing trajectory. Dividing by its zero total must not throw.
    const s = summarizeTurnCost(rows(new Array(40).fill(0)));
    expect(s.top5TurnShare).toBe(0);
    expect(Number.isNaN(s.top5TurnShare)).toBe(false);
  });

  it('reports the slowest turn when the rows carry wall time', () => {
    const s = summarizeTurnCost([
      { turn: 1, in: 0, out: 10, ms: 1200 },
      { turn: 2, in: 0, out: 20, ms: 600_000 },
      { turn: 3, in: 0, out: 30 },
    ]);
    expect(s.slowestTurnMs).toBe(600_000);
  });

  it('nearest-rank percentiles bracket a small sample the way the issue counts them', () => {
    const s = summarizeTurnCost(rows([1, 2, 3, 4]));
    expect(s.p50TurnOut).toBe(2);
    expect(s.p95TurnOut).toBe(4);
    // Fewer than five turns: the top-5 share is the whole run.
    expect(s.top5TurnShare).toBe(1);
  });
});

describe('edit pressure', () => {
  it('divides written bytes by verifications', () => {
    const p = editPressureOf({ edits: 51, editBytes: 75_000, largestEditBytes: 17_884, verifications: 6 });
    expect(p.editBytesPerVerify).toBe(12_500);
    expect(p.largestEditBytes).toBe(17_884);
  });

  it('an unverified run reports its bytes rather than dividing by zero', () => {
    const p = editPressureOf({ edits: 3, editBytes: 900, largestEditBytes: 400, verifications: 0 });
    expect(p.editBytesPerVerify).toBe(900);
  });

  it('folds two attempts of the same stage, keeping the largest single edit', () => {
    const a = editPressureOf({ edits: 2, editBytes: 1000, largestEditBytes: 800, verifications: 1 });
    const b = editPressureOf({ edits: 3, editBytes: 500, largestEditBytes: 200, verifications: 1 });
    const sum = addEditPressure(a, b);
    expect(sum.edits).toBe(5);
    expect(sum.editBytes).toBe(1500);
    expect(sum.largestEditBytes).toBe(800);
    expect(sum.editBytesPerVerify).toBe(750);
    expect(addEditPressure(EMPTY_EDIT_PRESSURE, a)).toEqual(a);
  });
});

describe('scoring a historical run directory', () => {
  it('scores a transcript recorded before any of this instrumentation existed', async () => {
    const scored = await readRunTurnCost(path.join(RUNS, '2026-07-29T18-02-20-554Z'));
    expect(scored).not.toBeNull();
    const { cost, pressure } = scored!;
    expect(cost.turns).toBe(40);
    expect(cost.p50TurnOut).toBe(177);
    expect(cost.maxTurnOut).toBe(43629);
    expect(Number(cost.top5TurnShare.toFixed(2))).toBe(0.89);
    // The rows have no `ms`, so wall time per turn is unknown rather than 0.
    expect(cost.slowestTurnMs).toBeNull();
    // Edit pressure reconstructed from the `tool` events: the 17,884-byte block
    // the issue calls out is the largest, and the check cadence is the ratio.
    expect(pressure.edits).toBe(6);
    expect(pressure.verifications).toBe(2);
    expect(pressure.largestEditBytes).toBe(17_884);
    expect(pressure.editBytesPerVerify).toBe(pressure.editBytes / 2);
  });

  it('returns null for a directory with no transcript', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-runs-'));
    try {
      expect(await readRunTurnCost(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
