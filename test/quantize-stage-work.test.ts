import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import { runAgentLoop } from '../src/agent/loop.js';
import type { Msg, Provider, Turn } from '../src/agent/types.js';
import { dispatchTool, freshEditCounters, type RunContext } from '../src/agent/tools.js';
import { ObligationsLedger } from '../src/agent/ledger.js';
import { Transcript } from '../src/agent/transcript.js';
import { loadConfig, normalizeStageBudgets, type CopperheadConfig } from '../src/config.js';
import { runInit } from '../src/memory/scaffold.js';
import { stageProgress } from '../src/commands/stage-progress.js';
import { tempFixtureRepo } from './helpers.js';

/**
 * Issue #145: the cost of a create stage is concentrated in a handful of giant
 * turns, and those are exactly the turns that die. These tests cover the two
 * halves of the fix — measuring the concentration, and quantizing the unit of
 * work at the tool layer so a lost turn costs one part instead of a stage.
 */

const SCH = 'hardware/open-key.kicad_sch';

/** Scripted provider: plays each turn in order, repeats the last one. */
function scriptedProvider(turns: Partial<Turn>[]): Provider & { seen: Msg[][] } {
  let i = 0;
  const seen: Msg[][] = [];
  return {
    name: 'scripted',
    seen,
    async chat(messages: Msg[]): Promise<Turn> {
      seen.push([...messages]);
      const t = turns[Math.min(i, turns.length - 1)]!;
      i++;
      return {
        text: t.text ?? null,
        toolCalls: (t.toolCalls ?? []).map((c, j) => ({ ...c, id: `call-${i}-${j}` })),
        usage: t.usage ?? { inputTokens: 100, outputTokens: 10 },
      };
    },
  };
}

const unlockTurn = {
  toolCalls: [
    { name: 'propose_change', args: { id: 'c1', why: 'w', what_changes: '- x', tasks: '- [ ] t' } },
    { name: 'validate_change', args: {} },
  ],
};

async function makeCtx(repo: string, overrides: Partial<CopperheadConfig> = {}): Promise<RunContext> {
  const transcript = new Transcript(repo);
  await transcript.init();
  return {
    repoRoot: repo,
    config: { ...(await loadConfig(repo)), ...overrides },
    transcript,
    ledger: new ObligationsLedger(),
    runId: 'test-run',
    interactive: false,
    confirm: async () => true,
    editsUnlocked: true,
    changeId: null,
    proposalValidated: false,
    filesTouched: new Set(),
    decisions: [],
    lastErc: null,
    lastDrc: null,
    repairCycles: 0,
    finishRequest: null,
    ...freshEditCounters(),
  };
}

describe('edit_file byte cap on KiCad files (issue #145 §B2)', () => {
  it('refuses an oversized schematic block and leaves the file byte-identical', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      const ctx = await makeCtx(repo);
      const sch = path.join(repo, SCH);
      const before = await readFile(sch, 'utf8');
      // The size the 65-minute run actually pushed into board.kicad_sch in one call.
      const res = await dispatchTool(ctx, 'edit_file', {
        path: SCH,
        old_string: '(paper "A4")',
        new_string: '(paper "A4")' + ' '.repeat(17_884),
      });
      expect(res).toContain('REFUSED');
      expect(res).toContain('17896 bytes'); // the attempted size
      expect(res).toContain('8192-byte'); // the cap
      expect(res).toContain('maxEditBytes'); // the setting that changes it
      expect(res).toContain('3 symbol(s) currently in this schematic'); // where the model is
      expect(await readFile(sch, 'utf8')).toBe(before);
      expect(ctx.filesTouched.has(SCH)).toBe(false);
      expect(ctx.editCounts.edits).toBe(0);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('does not cap documentation: a 20 kB SPEC.md section is written normally', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      const ctx = await makeCtx(repo);
      const specRel = path.join('docs', 'SPEC.md');
      const spec = path.join(repo, specRel);
      const anchor = (await readFile(spec, 'utf8')).split('\n')[0]!;
      const big = `${anchor}\n\n${'Prose that is legitimately written in one pass. '.repeat(500)}`;
      expect(Buffer.byteLength(big, 'utf8')).toBeGreaterThan(20_000);
      const res = await dispatchTool(ctx, 'edit_file', { path: specRel, old_string: anchor, new_string: big });
      expect(res).not.toContain('REFUSED');
      expect(await readFile(spec, 'utf8')).toContain('written in one pass');
      expect(ctx.editCounts.largestEditBytes).toBeGreaterThan(20_000);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('maxEditBytes: 0 disables the cap', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      const ctx = await makeCtx(repo, { maxEditBytes: 0 });
      const sch = path.join(repo, SCH);
      // Whitespace only, so the file stays loadable and the kicad-cli probe passes.
      const res = await dispatchTool(ctx, 'edit_file', {
        path: SCH,
        old_string: '(paper "A4")',
        new_string: '(paper "A4")' + '\n'.repeat(9_000),
      });
      expect(res).not.toContain('REFUSED');
      expect((await readFile(sch, 'utf8')).length).toBeGreaterThan(18_000);
    } finally {
      await cleanup();
    }
  }, 60_000);
});

describe('edit_file verify gate (issue #145 §B3)', () => {
  it('refuses a second unverified schematic edit and names the check to run', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      const ctx = await makeCtx(repo);
      const first = await dispatchTool(ctx, 'edit_file', {
        path: SCH,
        old_string: '(rev "A")',
        new_string: '(rev "B")',
      });
      expect(first).not.toContain('REFUSED');
      expect(ctx.unverifiedEdits.sch).toBe(1);

      const sch = path.join(repo, SCH);
      const afterFirst = await readFile(sch, 'utf8');
      const second = await dispatchTool(ctx, 'edit_file', {
        path: SCH,
        old_string: '(paper "A4")',
        new_string: '(paper "A3")',
      });
      expect(second).toContain('REFUSED');
      expect(second).toContain('run_erc');
      expect(second).toContain('maxUnverifiedEdits');
      expect(await readFile(sch, 'utf8')).toBe(afterFirst);
    } finally {
      await cleanup();
    }
  }, 90_000);

  it('edit → run_erc → edit passes the gate', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      const ctx = await makeCtx(repo);
      await dispatchTool(ctx, 'edit_file', { path: SCH, old_string: '(rev "A")', new_string: '(rev "B")' });
      const erc = await dispatchTool(ctx, 'run_erc', {});
      expect(erc).toContain('clean');
      expect(ctx.unverifiedEdits.sch).toBe(0);
      const second = await dispatchTool(ctx, 'edit_file', {
        path: SCH,
        old_string: '(paper "A4")',
        new_string: '(paper "A3")',
      });
      expect(second).not.toContain('REFUSED');
      expect(await readFile(path.join(repo, SCH), 'utf8')).toContain('(paper "A3")');
      expect(ctx.editCounts.verifications).toBe(1);
    } finally {
      await cleanup();
    }
  }, 90_000);

  it('a FAILING run_erc still resets the counter, so repair is never deadlocked', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      const ctx = await makeCtx(repo);
      // Detach the GPIO0 no-connect flag: the pin becomes unconnected and ERC fails.
      const broke = await dispatchTool(ctx, 'edit_file', {
        path: SCH,
        old_string: '(no_connect (at 127 96.52)',
        new_string: '(no_connect (at 127 50.8)',
      });
      expect(broke).not.toContain('REFUSED');
      expect(ctx.unverifiedEdits.sch).toBe(1);

      const erc = await dispatchTool(ctx, 'run_erc', {});
      expect(erc).not.toContain('clean');
      expect(ctx.lastErc!.ok).toBe(false);
      expect(ctx.unverifiedEdits.sch).toBe(0);

      // The repair edit — the one a pass-only reset would have refused forever.
      const repair = await dispatchTool(ctx, 'edit_file', {
        path: SCH,
        old_string: '(no_connect (at 127 50.8)',
        new_string: '(no_connect (at 127 96.52)',
      });
      expect(repair).not.toContain('REFUSED');
      expect((await dispatchTool(ctx, 'run_erc', {})).toLowerCase()).toContain('clean');
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('maxUnverifiedEdits: 0 disables the gate', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      const ctx = await makeCtx(repo, { maxUnverifiedEdits: 0 });
      await dispatchTool(ctx, 'edit_file', { path: SCH, old_string: '(rev "A")', new_string: '(rev "B")' });
      const second = await dispatchTool(ctx, 'edit_file', {
        path: SCH,
        old_string: '(paper "A4")',
        new_string: '(paper "A3")',
      });
      expect(second).not.toContain('REFUSED');
    } finally {
      await cleanup();
    }
  }, 90_000);
});

describe('checkpoint commits (issue #145 §B4)', () => {
  /** Set up a repo with docs committed and one unrelated dirty file. */
  async function repoWithDirtyBystander(): Promise<{ repo: string; cleanup: () => Promise<void> }> {
    const { repo, cleanup } = await tempFixtureRepo();
    await runInit({ repoRoot: repo, installHooks: false });
    await execa('git', ['add', '-A'], { cwd: repo });
    await execa('git', ['commit', '-q', '-m', 'docs'], { cwd: repo });
    await writeFile(path.join(repo, 'docs', 'DEVPLAN.md'), 'my own work in progress\n', 'utf8');
    await execa('git', ['add', '-A'], { cwd: repo });
    await execa('git', ['commit', '-q', '-m', 'bystander'], { cwd: repo });
    await writeFile(path.join(repo, 'docs', 'DEVPLAN.md'), 'my own work in progress, edited\n', 'utf8');
    return { repo, cleanup };
  }

  it('commits the verified unit, keeps it across a later failure, and leaves a bystander alone', async () => {
    const { repo, cleanup } = await repoWithDirtyBystander();
    try {
      const provider = scriptedProvider([
        unlockTurn,
        { toolCalls: [{ name: 'edit_file', args: { path: SCH, old_string: '(rev "A")', new_string: '(rev "B")' } }] },
        { toolCalls: [{ name: 'run_erc', args: {} }] },
        { toolCalls: [{ name: 'read_file', args: { path: SCH, start_line: 1, end_line: 2 } }] },
      ]);
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'checkpoint me',
        model: 'gpt-5',
        provider,
        maxTurns: 4,
        allowDirty: true,
        log: () => {},
      });
      // The run itself fails (it never calls finish) — that is the point.
      expect(res.outcome).toBe('failure');
      expect(res.exitPath).toBe('turn-budget-exhausted');

      const { stdout: log } = await execa('git', ['log', '--pretty=%s'], { cwd: repo });
      expect(log).toContain('copperhead: checkpoint — checkpoint me');
      // Distinguishable from a stage commit, so history stays greppable.
      expect(log).not.toContain('copperhead: create pipeline stage');

      // The verified edit survived the failure's rollback.
      expect(await readFile(path.join(repo, SCH), 'utf8')).toContain('(rev "B")');
      const { stdout: committed } = await execa('git', ['show', '--name-only', '--pretty=', 'HEAD'], { cwd: repo });
      expect(committed).toContain(SCH);
      // The operator's unrelated change was neither committed nor destroyed.
      expect(committed).not.toContain('DEVPLAN.md');
      expect(await readFile(path.join(repo, 'docs', 'DEVPLAN.md'), 'utf8')).toContain('edited');
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('never checkpoints a dry run', async () => {
    const { repo, cleanup } = await repoWithDirtyBystander();
    try {
      const { stdout: headBefore } = await execa('git', ['rev-parse', 'HEAD'], { cwd: repo });
      const provider = scriptedProvider([
        unlockTurn,
        { toolCalls: [{ name: 'edit_file', args: { path: SCH, old_string: '(rev "A")', new_string: '(rev "B")' } }] },
        { toolCalls: [{ name: 'run_erc', args: {} }] },
        { toolCalls: [{ name: 'check_drift', args: {} }] },
        { toolCalls: [{ name: 'finish', args: { outcome: 'done', summary: 'dry' } }] },
      ]);
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'dry checkpoint',
        model: 'gpt-5',
        provider,
        maxTurns: 6,
        allowDirty: true,
        dryRun: true,
        log: () => {},
      });
      expect(res.outcome).toBe('success');
      const { stdout: headAfter } = await execa('git', ['rev-parse', 'HEAD'], { cwd: repo });
      expect(headAfter).toBe(headBefore);
      const { stdout: log } = await execa('git', ['log', '--pretty=%s'], { cwd: repo });
      expect(log).not.toContain('checkpoint');
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('checkpointCommits: false turns the mechanism off', async () => {
    const { repo, cleanup } = await repoWithDirtyBystander();
    try {
      const cfgPath = path.join(repo, '.copperhead', 'config.json');
      const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as Record<string, unknown>;
      await writeFile(cfgPath, JSON.stringify({ ...cfg, checkpointCommits: false }, null, 2), 'utf8');
      const { stdout: headBefore } = await execa('git', ['rev-parse', 'HEAD'], { cwd: repo });
      const provider = scriptedProvider([
        unlockTurn,
        { toolCalls: [{ name: 'edit_file', args: { path: SCH, old_string: '(rev "A")', new_string: '(rev "B")' } }] },
        { toolCalls: [{ name: 'run_erc', args: {} }] },
        { toolCalls: [{ name: 'read_file', args: { path: SCH, start_line: 1, end_line: 2 } }] },
      ]);
      await runAgentLoop({
        repoRoot: repo,
        request: 'no checkpoints please',
        model: 'gpt-5',
        provider,
        maxTurns: 4,
        allowDirty: true,
        log: () => {},
      });
      const { stdout: headAfter } = await execa('git', ['rev-parse', 'HEAD'], { cwd: repo });
      expect(headAfter).toBe(headBefore);
    } finally {
      await cleanup();
    }
  }, 120_000);
});

describe('per-stage spend budgets (issue #145 §C)', () => {
  const readCall = { name: 'read_file', args: { path: SCH, start_line: 1, end_line: 2 } };

  it('exhausting the output-token budget ends the run on its own exit path', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const provider = scriptedProvider([{ toolCalls: [readCall], usage: { inputTokens: 10, outputTokens: 500 } }]);
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'spend it',
        model: 'gpt-5',
        provider,
        maxTurns: 50,
        budget: { maxTokensOut: 1000 },
        log: () => {},
      });
      expect(res.exitPath).toBe('token-budget-exhausted');
      expect(res.outcome).toBe('failure');
      expect(res.summary).toContain('output token budget exhausted');
      // Distinct from turn exhaustion: #135's escalation must not fire on it.
      expect(res.stats.turnsUsed).toBe(2);
      const { stdout: status } = await execa('git', ['status', '--porcelain'], { cwd: repo });
      expect(status).toBe('');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('exhausting the wall budget ends the run on its own exit path', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const provider = scriptedProvider([{ toolCalls: [readCall] }]);
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'take too long',
        model: 'gpt-5',
        provider,
        maxTurns: 50,
        budget: { maxWallMs: 1 },
        log: () => {},
      });
      expect(res.exitPath).toBe('wall-budget-exhausted');
      expect(res.summary).toContain('wall-clock budget exhausted');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('an oversized turn is told to split the unit and the run continues', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const provider = scriptedProvider([
        { toolCalls: [readCall], usage: { inputTokens: 10, outputTokens: 43_629 } },
        { toolCalls: [{ name: 'finish', args: { outcome: 'done', summary: 'ok' } }], usage: { inputTokens: 10, outputTokens: 5 } },
      ]);
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'one huge turn',
        model: 'gpt-5',
        provider,
        maxTurns: 6,
        budget: { maxTurnOut: 8000 },
        log: () => {},
      });
      // Continued, not aborted: the turn was already paid for.
      expect(res.outcome).toBe('success');
      expect(res.exitPath).toBe('done');
      const nudged = provider.seen.at(-1)!.filter((m) => m.role === 'user').map((m) => String(m.content));
      expect(nudged.some((c) => c.includes('Split the unit'))).toBe(true);
      const jsonl = await readFile(path.join(res.transcriptDir, 'transcript.jsonl'), 'utf8');
      expect(jsonl).toContain('"turn-too-large"');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('normalizeStageBudgets drops entries that cannot mean anything', () => {
    expect(normalizeStageBudgets({ schematic: { maxTokensOut: 0 } })).toEqual({});
    expect(normalizeStageBudgets({ schematic: { maxTokensOut: -5, maxWallMs: 1.5 } })).toEqual({});
    expect(normalizeStageBudgets({ schematic: 'nope' })).toEqual({});
    expect(normalizeStageBudgets(null)).toEqual({});
    expect(normalizeStageBudgets({ schematic: { maxTokensOut: 120_000, maxTurnOut: 8000 } })).toEqual({
      schematic: { maxTokensOut: 120_000, maxTurnOut: 8000 },
    });
  });
});

describe('run stats carry concentration and edit pressure (issue #145 §A)', () => {
  it('run-end and summary.md report them on a failing run too', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'docs'], { cwd: repo });
      const provider = scriptedProvider([
        unlockTurn,
        { toolCalls: [{ name: 'edit_file', args: { path: SCH, old_string: '(rev "A")', new_string: '(rev "B")' } }] },
        { toolCalls: [{ name: 'run_erc', args: {} }] },
      ]);
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'measure me',
        model: 'gpt-5',
        provider,
        maxTurns: 3,
        log: () => {},
      });
      expect(res.exitPath).toBe('turn-budget-exhausted');
      expect(res.stats.perTurn.every((t) => typeof t.ms === 'number')).toBe(true);
      expect(res.stats.turnCost).toBeDefined();
      expect(res.stats.turnCost!.turns).toBe(3);
      expect(res.stats.turnCost!.slowestTurnMs).not.toBeNull();
      expect(res.stats.editPressure!.edits).toBe(1);
      expect(res.stats.editPressure!.verifications).toBe(1);
      expect(res.stats.editPressure!.largestEditBytes).toBe('(rev "B")'.length);

      const summary = await readFile(path.join(res.transcriptDir, 'summary.md'), 'utf8');
      expect(summary).toContain('**Turn cost:**');
      expect(summary).toContain('top-5 share');
      expect(summary).toContain('**Edit pressure:**');
      const jsonl = await readFile(path.join(res.transcriptDir, 'transcript.jsonl'), 'utf8');
      expect(jsonl).toContain('"turnCost"');
      expect(jsonl).toContain('"editPressure"');
    } finally {
      await cleanup();
    }
  }, 120_000);
});

describe('computed stage progress (issue #145 §B5)', () => {
  it('names the BOM refdes the schematic is still missing', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      const config = await loadConfig(repo);
      await writeFile(
        path.join(repo, 'docs', 'BOM.md'),
        [
          '# BOM',
          '',
          '| Refdes | Value | Footprint | MPN | Rationale |',
          '| --- | --- | --- | --- | --- |',
          '| R1 | 10k | R_0603 | RC0603 | pullup |',
          '| R2 | 10k | R_0603 | RC0603 | pullup |',
          '| U1 | ESP32 | QFN | ESP32-C3 | mcu |',
          '| C7 | 100n | C_0402 | CC0402 | decoupling |',
          '| U2 | LDO | SOT23 | XC6220 | rail |',
          '',
        ].join('\n'),
        'utf8',
      );
      const p = await stageProgress(repo, config, 'schematic');
      expect(p).not.toBeNull();
      expect(p!.done).toBe(3);
      expect(p!.total).toBe(5);
      expect(p!.missing).toEqual(['C7', 'U2']);
      expect(p!.line).toContain('3 of 5 BOM parts present in the schematic');
      expect(p!.line).toContain('C7, U2');
      expect(p!.line).toContain('Continue at the first missing unit');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('counts schematic symbols against board footprints for layout-draft', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      const config = await loadConfig(repo);
      const p = await stageProgress(repo, config, 'layout-draft');
      expect(p).not.toBeNull();
      // The fixture board is blank: no symbol has a footprint on it yet.
      expect(p!.done).toBe(0);
      expect(p!.missing).toEqual(['R1', 'R2', 'U1']);
      expect(p!.line).toContain('0 of 3 schematic symbols present in the board as footprints');

      // Place one, and the line moves with repo state.
      const board = path.join(repo, config.board!);
      await writeFile(
        board,
        (await readFile(board, 'utf8')).replace(
          /\)\s*$/,
          '  (footprint "R_0603" (layer "F.Cu") (property "Reference" "R1" (at 0 0)))\n)\n',
        ),
        'utf8',
      );
      const after = await stageProgress(repo, config, 'layout-draft');
      expect(after!.done).toBe(1);
      expect(after!.missing).toEqual(['R2', 'U1']);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('a stage with no countable unit list gets no progress line', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      const config = await loadConfig(repo);
      expect(await stageProgress(repo, config, 'spec-seed')).toBeNull();
      expect(await stageProgress(repo, config, 'devplan')).toBeNull();
    } finally {
      await cleanup();
    }
  }, 60_000);
});
