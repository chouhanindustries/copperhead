import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  dispatchTool,
  newRepairProgress,
  recordCheckForBudget,
  type RunContext,
} from '../src/agent/tools.js';
import { ObligationsLedger } from '../src/agent/ledger.js';
import { Transcript } from '../src/agent/transcript.js';
import { loadConfig, DEFAULTS } from '../src/config.js';
import type { CheckReport } from '../src/kicad/report.js';

// The run_erc/run_drc handlers shell out to kicad-cli; mock only those two so
// the handler-level tests can script exact violation counts per report.
const runErcMock = vi.hoisted(() => vi.fn());
const runDrcMock = vi.hoisted(() => vi.fn());
vi.mock('../src/kicad/cli.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/kicad/cli.js')>()),
  runErc: runErcMock,
  runDrc: runDrcMock,
}));

const MAX = DEFAULTS.maxRepairCycles; // 5: the loop fails when repairCycles > MAX

function report(source: 'erc' | 'drc', count: number): CheckReport {
  return {
    ok: count === 0,
    source,
    violations: Array.from({ length: count }, (_, i) => ({
      severity: 'error',
      type: 'test_violation',
      description: `violation ${i}`,
      items: [],
    })),
  };
}

/** recordCheckForBudget only touches repairCycles and repairProgress. */
function trackerCtx(): RunContext {
  return { repairCycles: 0, repairProgress: newRepairProgress() } as RunContext;
}

const exhausted = (ctx: RunContext): boolean => ctx.repairCycles > MAX;

describe('repair budget bounds stagnation, not attempts (recordCheckForBudget)', () => {
  it('a strictly improving sequence never exhausts, no matter how long', () => {
    const ctx = trackerCtx();
    // Far more failing checks than maxRepairCycles, every one an improvement:
    // the incremental one-part-at-a-time workflow the schematic stage demands.
    for (const count of [20, 18, 15, 12, 10, 8, 7, 5, 4, 3, 2, 1]) {
      recordCheckForBudget(ctx, report('erc', count));
      expect(ctx.repairCycles).toBe(0);
      expect(exhausted(ctx)).toBe(false);
    }
  });

  it('a stagnant sequence exhausts exactly at the bound', () => {
    const ctx = trackerCtx();
    recordCheckForBudget(ctx, report('erc', 4)); // baseline, does not count
    expect(ctx.repairCycles).toBe(0);
    for (let i = 1; i <= MAX; i++) {
      recordCheckForBudget(ctx, report('erc', 4));
      expect(ctx.repairCycles).toBe(i);
      expect(exhausted(ctx)).toBe(false); // at the bound, not past it
    }
    recordCheckForBudget(ctx, report('erc', 4)); // one more non-improving check
    expect(exhausted(ctx)).toBe(true);
  });

  it('a regression (violation count grows) counts against the budget', () => {
    const ctx = trackerCtx();
    recordCheckForBudget(ctx, report('erc', 3));
    recordCheckForBudget(ctx, report('erc', 6));
    expect(ctx.repairCycles).toBe(1);
  });

  it('an improvement resets the stagnation streak', () => {
    const ctx = trackerCtx();
    recordCheckForBudget(ctx, report('erc', 5)); // baseline
    recordCheckForBudget(ctx, report('erc', 5)); // streak 1
    recordCheckForBudget(ctx, report('erc', 5)); // streak 2
    expect(ctx.repairCycles).toBe(2);
    recordCheckForBudget(ctx, report('erc', 4)); // strict improvement resets
    expect(ctx.repairCycles).toBe(0);
    recordCheckForBudget(ctx, report('erc', 4)); // streak 1 again
    recordCheckForBudget(ctx, report('erc', 4)); // streak 2
    expect(ctx.repairCycles).toBe(2);
    expect(exhausted(ctx)).toBe(false);
  });

  it('a clean pass resets both the streak and the baseline', () => {
    const ctx = trackerCtx();
    recordCheckForBudget(ctx, report('erc', 3));
    recordCheckForBudget(ctx, report('erc', 3));
    expect(ctx.repairCycles).toBe(1);
    recordCheckForBudget(ctx, report('erc', 0)); // clean
    expect(ctx.repairCycles).toBe(0);
    // A later, unrelated failure starts a fresh sequence: 9 > 3 must not read
    // as a regression against the pre-clean baseline.
    recordCheckForBudget(ctx, report('erc', 9));
    expect(ctx.repairCycles).toBe(0);
    expect(ctx.repairProgress.lastFailCount.erc).toBe(9);
  });

  it('ERC and DRC are tracked independently', () => {
    const ctx = trackerCtx();
    // ERC stagnates while DRC improves: DRC progress must not launder the
    // stuck ERC loop, and improving DRC must never accrue stagnation.
    recordCheckForBudget(ctx, report('erc', 5)); // erc baseline
    recordCheckForBudget(ctx, report('drc', 8)); // drc baseline
    recordCheckForBudget(ctx, report('erc', 5)); // erc streak 1
    recordCheckForBudget(ctx, report('drc', 6)); // drc improves, streak 0
    recordCheckForBudget(ctx, report('erc', 5)); // erc streak 2
    recordCheckForBudget(ctx, report('drc', 4)); // drc improves, streak 0
    expect(ctx.repairProgress.stagnant.erc).toBe(2);
    expect(ctx.repairProgress.stagnant.drc).toBe(0);
    expect(ctx.repairCycles).toBe(2); // worst streak wins
    // An ERC improvement resets only ERC; a DRC stall then still counts.
    recordCheckForBudget(ctx, report('erc', 2));
    recordCheckForBudget(ctx, report('drc', 4)); // drc streak 1
    expect(ctx.repairProgress.stagnant.erc).toBe(0);
    expect(ctx.repairProgress.stagnant.drc).toBe(1);
    expect(ctx.repairCycles).toBe(1);
  });
});

describe('run_erc / run_drc handlers feed the stagnation tracker', () => {
  let repo: string;
  let ctx: RunContext;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'copperhead-repair-'));
    const transcript = new Transcript(repo);
    await transcript.init();
    const config = await loadConfig(repo);
    config.schematic = 'hardware/board.kicad_sch';
    config.board = 'hardware/board.kicad_pcb';
    ctx = {
      repoRoot: repo,
      config,
      transcript,
      ledger: new ObligationsLedger(),
      runId: 'test-run',
      interactive: false,
      confirm: async () => true,
      editsUnlocked: false,
      changeId: null,
      proposalValidated: false,
      filesTouched: new Set(),
      decisions: [],
      lastErc: null,
      lastDrc: null,
      repairCycles: 0,
      repairProgress: newRepairProgress(),
      finishRequest: null,
    };
    runErcMock.mockReset();
    runDrcMock.mockReset();
    return async () => rm(repo, { recursive: true, force: true });
  });

  it('run_erc: an improving ERC sequence longer than the budget stays unexhausted', async () => {
    for (const count of [10, 7, 5, 3, 2, 1]) {
      runErcMock.mockResolvedValueOnce(report('erc', count));
      const out = await dispatchTool(ctx, 'run_erc', {});
      expect(out).toContain(`${count} violation(s)`);
      expect(ctx.repairCycles).toBe(0);
    }
    expect(ctx.repairCycles > ctx.config.maxRepairCycles).toBe(false);
  });

  it('run_erc: a stagnant ERC sequence exhausts past the bound', async () => {
    for (let i = 0; i <= MAX + 1; i++) {
      runErcMock.mockResolvedValueOnce(report('erc', 4));
      await dispatchTool(ctx, 'run_erc', {});
    }
    expect(ctx.repairCycles).toBe(MAX + 1);
    expect(ctx.repairCycles > ctx.config.maxRepairCycles).toBe(true);
  });

  it('run_drc: stagnation on the board counts even while ERC improves', async () => {
    for (let i = 0; i < 3; i++) {
      runDrcMock.mockResolvedValueOnce(report('drc', 6));
      await dispatchTool(ctx, 'run_drc', {});
      runErcMock.mockResolvedValueOnce(report('erc', 5 - i));
      await dispatchTool(ctx, 'run_erc', {});
    }
    expect(ctx.repairProgress.stagnant.drc).toBe(2);
    expect(ctx.repairProgress.stagnant.erc).toBe(0);
    expect(ctx.repairCycles).toBe(2);
  });
});
