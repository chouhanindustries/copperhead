import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import { runAgentLoop } from '../src/agent/loop.js';
import type { Msg, Provider, Turn } from '../src/agent/types.js';
import { runCreate, descendantsOf, STAGES, stageNames } from '../src/commands/create.js';
import { createStatePath, loadCreateState } from '../src/memory/stagestate.js';
import { runInit } from '../src/memory/scaffold.js';
import { tempFixtureRepo } from './helpers.js';

/**
 * kicad-cli PATH shim. The fixture below is a real initialized project
 * (config.schematic/config.board set), so every non-dry `runCreate` ends with
 * runCheck shelling out to kicad-cli for ERC/DRC. These tests are about
 * pipeline record/staleness semantics, not KiCad itself, so a shim answers
 * with a clean JSON report — deterministic and hermetic on machines without
 * KiCad installed. Mutating process.env.PATH here is safe only because vitest
 * isolates test files in separate workers; the shim never leaks to other files.
 */
let kicadShimDir: string;
let realPath: string;

beforeAll(async () => {
  kicadShimDir = await mkdtemp(path.join(tmpdir(), 'copperhead-kicad-shim-'));
  const shim = [
    '#!/bin/sh',
    '# fake kicad-cli for copperhead pipeline tests: version + clean ERC/DRC reports',
    'if [ "$1" = "version" ]; then echo "9.0.0"; exit 0; fi',
    'out=""',
    'prev=""',
    'for a in "$@"; do',
    '  if [ "$prev" = "--output" ]; then out="$a"; fi',
    '  prev="$a"',
    'done',
    'if [ -n "$out" ]; then printf "{}" > "$out"; fi',
    'exit 0',
    '',
  ].join('\n');
  await writeFile(path.join(kicadShimDir, 'kicad-cli'), shim, 'utf8');
  await chmod(path.join(kicadShimDir, 'kicad-cli'), 0o755);
  realPath = process.env.PATH ?? '';
  process.env.PATH = `${kicadShimDir}${path.delimiter}${realPath}`;
});

afterAll(async () => {
  process.env.PATH = realPath;
  await rm(kicadShimDir, { recursive: true, force: true });
});

/** Replays a fixed script of turns; the last turn repeats forever. */
class ScriptedProvider implements Provider {
  readonly name = 'scripted';
  private i = 0;
  constructor(private readonly turns: Turn[]) {}
  async chat(): Promise<Turn> {
    const t = this.turns[Math.min(this.i, this.turns.length - 1)]!;
    this.i++;
    return t;
  }
}

/**
 * Stage-aware provider: the loop's opening user message ends with
 * `Request: create pipeline stage: <name>`, so one instance can serve
 * consecutive stage runs of a single `runCreate` invocation by picking the
 * script for the stage being run. Stages without a script get a bare
 * finish("done") — a run that produces nothing. Opening prompts are recorded
 * for the preamble assertions.
 */
class StageScriptProvider implements Provider {
  readonly name = 'stage-scripts';
  readonly prompts: string[] = [];
  private readonly cursor = new Map<string, number>();
  constructor(private readonly scripts: Record<string, Turn[]> = {}) {}
  /** The full opening prompt of a given stage's run (stage prompt + request line). */
  promptFor(stage: string): string | undefined {
    return this.prompts.find((p) => p.endsWith(`Request: create pipeline stage: ${stage}`));
  }
  async chat(messages: Msg[]): Promise<Turn> {
    const opening = messages.find((m) => m.role === 'user');
    const content = opening && typeof opening.content === 'string' ? opening.content : '';
    if (content && !this.prompts.includes(content)) this.prompts.push(content);
    const stage = /Request: create pipeline stage: (.+)\s*$/.exec(content)?.[1] ?? '';
    const script = this.scripts[stage] ?? [finishTurn('done')];
    const i = this.cursor.get(stage) ?? 0;
    this.cursor.set(stage, i + 1);
    return script[Math.min(i, script.length - 1)]!;
  }
}

const turn = (calls: { name: string; args: Record<string, unknown> }[]): Turn => ({
  text: null,
  toolCalls: calls.map((c, i) => ({ id: `c${i}`, name: c.name, args: c.args })),
  usage: { inputTokens: 10, outputTokens: 5 },
});

const finishTurn = (outcome: 'done' | 'refuse' = 'done'): Turn =>
  turn([{ name: 'finish', args: { outcome, summary: 'scripted' } }]);

const proposeTurn = (id: string): Turn =>
  turn([
    { name: 'propose_change', args: { id, why: 'test', what_changes: `- ${id}`, tasks: '- [ ] t' } },
    { name: 'validate_change', args: {} },
  ]);

/** outputs earns its record by creating the probe artifact (outputs/ exists). */
const outputsScript = (): Turn[] => [
  proposeTurn('create-outputs'),
  turn([{ name: 'write_file', args: { path: 'outputs/BOM.csv', content: 'Refdes,MPN,Qty\nR1,UNVERIFIED,1\n' } }]),
  finishTurn('done'),
];

/** firmware earns its record by creating firmware/pins.h (fixed bytes, so a re-run restores the exact hash). */
const firmwareScript = (): Turn[] => [
  proposeTurn('create-firmware'),
  turn([{ name: 'write_file', args: { path: 'firmware/pins.h', content: '#define LED 0\n' } }]),
  finishTurn('done'),
];

/** devplan writes a .md → drift obligation → check_drift (clean: init docs match the real schematic). */
const devplanScript = (): Turn[] => [
  proposeTurn('create-devplan'),
  turn([{ name: 'write_file', args: { path: 'docs/DEVPLAN.md', content: '# Development plan\n\n1. bring-up\n' } }]),
  turn([{ name: 'check_drift', args: {} }]),
  finishTurn('done'),
];

/** A full default run: the three incomplete stages each produce their probe artifact. */
const fullRunProvider = (): StageScriptProvider =>
  new StageScriptProvider({ outputs: outputsScript(), firmware: firmwareScript(), devplan: devplanScript() });

/** Every stage run finishes immediately without producing anything. */
const finishOnlyProvider = (): StageScriptProvider => new StageScriptProvider();

/**
 * part-selection revises BOM.md's rationale column via the agent — the bom
 * hash changes (propagation trigger) but the rationale column is not
 * drift-checked, so check_drift stays clean and finish is not blocked.
 */
const editBomScript = (): Turn[] => [
  proposeTurn('revise-bom'),
  turn([
    {
      name: 'edit_file',
      args: {
        path: 'docs/BOM.md',
        old_string: 'extracted from schematic by copperhead init',
        new_string: 'revised by test',
        replace_all: true,
      },
    },
  ]),
  turn([{ name: 'check_drift', args: {} }]),
  finishTurn('done'),
];

/**
 * Fixture: real `copperhead init` over the open-key project, committed. The
 * generated docs are drift-clean against the real schematic and the stage
 * probes classify honestly with no records: spec-seed, architecture,
 * part-selection, schematic, layout-draft are assumed-complete; outputs,
 * firmware, devplan are incomplete. A default full run therefore executes
 * exactly [outputs, firmware, devplan].
 */
async function createFixture(): Promise<{ repo: string; brief: string; cleanup: () => Promise<void> }> {
  const { repo, cleanup } = await tempFixtureRepo();
  await runInit({ repoRoot: repo, installHooks: false });
  const brief = path.join(repo, 'brief.md');
  await writeFile(brief, '# Brief\n\nA tiny USB-C power breakout.\n', 'utf8');
  await execa('git', ['add', '-A'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', 'init scaffold + brief'], { cwd: repo });
  return { repo, brief, cleanup };
}

/** Hand edit (outside the agent): only BOM.md's rationale text — the bom hash changes, drift stays clean. */
async function handEditBomRationale(repo: string): Promise<void> {
  const p = path.join(repo, 'docs', 'BOM.md');
  const text = await readFile(p, 'utf8');
  await writeFile(p, text.replaceAll('extracted from schematic by copperhead init', 'hand-tuned rationale'), 'utf8');
}

function createOpts(repo: string, brief: string, lines: string[], extra: Record<string, unknown> = {}) {
  return {
    repoRoot: repo,
    briefPath: brief,
    model: 'gpt-5',
    provider: fullRunProvider(),
    log: (s: string) => lines.push(s),
    meta: { command: 'create' as const, modelSource: 'flag' as const, version: '9.9.9', kicadCliVersion: '9.0.0' },
    ...extra,
  };
}

const ranStages = (lines: string[]): string[] =>
  lines.filter((l) => l.startsWith('stage ') && l.includes(': running')).map((l) => l.split(':')[0]!.slice(6));

describe('stage graph (design D1)', () => {
  it('the STAGES order is a topological order of the produces→consumes graph', () => {
    const produced = new Set<string>(['brief']);
    for (const s of STAGES) {
      for (const a of s.consumes) expect(produced.has(a), `${s.name} consumes ${a} before it is produced`).toBe(true);
      for (const a of s.produces) produced.add(a);
    }
  });

  it('descendantsOf follows artifact edges, not list order', () => {
    expect(descendantsOf('layout-draft')).toEqual(['outputs', 'devplan']); // firmware is NOT downstream of the board
    expect(descendantsOf('part-selection')).toEqual(['schematic', 'layout-draft', 'outputs', 'firmware', 'devplan']);
    expect(descendantsOf('firmware')).toEqual(['devplan']);
    expect(descendantsOf('devplan')).toEqual([]);
  });
});

describe('flag validation', () => {
  const noop = (): void => {};
  it('an unknown stage name lists the valid stages', async () => {
    await expect(
      runCreate({ repoRoot: '/tmp', briefPath: 'x.md', model: 'gpt-5', stage: 'part-slection', log: noop }),
    ).rejects.toThrow(new RegExp(`valid stages: ${stageNames().join(', ')}`));
  });
  it('--stage and --from are mutually exclusive', async () => {
    await expect(
      runCreate({ repoRoot: '/tmp', briefPath: 'x.md', model: 'gpt-5', stage: 'outputs', from: 'schematic', log: noop }),
    ).rejects.toThrow(/mutually exclusive/);
  });
});

describe('beforeCommit seam (design D3)', () => {
  it('fires after the gates and lands its file in the run commit', async () => {
    const { repo, cleanup } = await createFixture();
    try {
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'seam test',
        model: 'gpt-5',
        provider: new ScriptedProvider([finishTurn('done')]),
        beforeCommit: async ({ runId }) => {
          expect(runId).toBeTruthy();
          await writeFile(path.join(repo, 'marker.txt'), 'bookkeeping\n', 'utf8');
        },
      });
      expect(res.outcome).toBe('success');
      const { stdout } = await execa('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], { cwd: repo });
      expect(stdout).toContain('marker.txt');
    } finally {
      await cleanup();
    }
  });

  it('never fires on the refuse path', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const hook = vi.fn();
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'refuse test',
        model: 'gpt-5',
        provider: new ScriptedProvider([finishTurn('refuse')]),
        beforeCommit: hook,
      });
      expect(res.outcome).toBe('refused');
      expect(hook).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it('never fires on the dry-run path', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const hook = vi.fn();
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'dry run seam test',
        model: 'gpt-5',
        dryRun: true,
        provider: new ScriptedProvider([finishTurn('done')]),
        beforeCommit: hook,
      });
      expect(res.outcome).toBe('success');
      expect(res.commit).toBeNull(); // dry run reverts instead of committing
      expect(hook).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it('a throw routes to commit-failed, not an unhandled rejection', async () => {
    const { repo, cleanup } = await createFixture();
    try {
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'seam failure test',
        model: 'gpt-5',
        provider: new ScriptedProvider([finishTurn('done')]),
        beforeCommit: async () => {
          throw new Error('disk full');
        },
      });
      expect(res.outcome).toBe('failure');
      expect(res.exitPath).toBe('commit-failed');
      const summary = await readFile(path.join(res.transcriptDir, 'summary.md'), 'utf8');
      expect(summary).toContain('commit preparation failed: disk full');
    } finally {
      await cleanup();
    }
  });
});

describe('create pipeline: records, staleness, targeted re-runs', () => {
  it('a default run executes the incomplete stages, records each inside its stage commit, then is a no-op', async () => {
    const { repo, brief, cleanup } = await createFixture();
    try {
      const lines: string[] = [];
      const res = await runCreate(createOpts(repo, brief, lines));
      expect(res.ok).toBe(true);
      // the init scaffold satisfies the first five stage probes
      expect(lines).toContain('stage part-selection: already complete (resuming past it)');
      expect(lines.filter((l) => l.includes('already complete (resuming past it)')).length).toBe(5);
      expect(ranStages(lines)).toEqual(['outputs', 'firmware', 'devplan']);
      // every stage produced its probe artifact, so every record was earned
      expect(lines.join('\n')).not.toContain('completion contract is not met');

      const { state } = await loadCreateState(repo);
      expect(Object.keys(state.stages).sort()).toEqual(['devplan', 'firmware', 'outputs']);
      // the record rides the stage's own commit
      const { stdout } = await execa('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], { cwd: repo });
      expect(stdout).toContain('.copperhead/create-state.json');

      // second run: recorded stages fresh, probed stages assumed-complete, nothing runs
      const lines2: string[] = [];
      const res2 = await runCreate(createOpts(repo, brief, lines2));
      expect(res2.ok).toBe(true);
      expect(ranStages(lines2)).toEqual([]);
      expect(lines2.filter((l) => l.includes('fresh (skipping)')).length).toBe(3);
      expect(lines2.filter((l) => l.includes('already complete (resuming past it)')).length).toBe(5);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('a hand edit to BOM.md makes its recorded consumers stale and a default run heals them', async () => {
    const { repo, brief, cleanup } = await createFixture();
    try {
      await runCreate(createOpts(repo, brief, []));
      // record schematic so the bom edge has a record to compare against
      await runCreate(createOpts(repo, brief, [], { stage: 'schematic', provider: finishOnlyProvider() }));
      await handEditBomRationale(repo);

      const lines: string[] = [];
      const res = await runCreate(createOpts(repo, brief, lines, { provider: finishOnlyProvider() }));
      expect(res.ok).toBe(true);
      // schematic and outputs consume bom; nothing else re-runs
      expect(ranStages(lines)).toEqual(['schematic', 'outputs']);
      expect(lines).toContain('stage schematic: running (stale: bom)');
      expect(lines).toContain('stage outputs: running (stale: bom)');

      const lines2: string[] = [];
      await runCreate(createOpts(repo, brief, lines2, { provider: finishOnlyProvider() }));
      expect(ranStages(lines2)).toEqual([]); // healed: idempotent again
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('--stage re-runs one stage and propagates only real output changes (issue #24 flow)', async () => {
    const { repo, brief, cleanup } = await createFixture();
    try {
      await runCreate(createOpts(repo, brief, []));
      // record schematic so it participates in bom-edge staleness
      await runCreate(createOpts(repo, brief, [], { stage: 'schematic', provider: finishOnlyProvider() }));

      const lines: string[] = [];
      const res = await runCreate(
        createOpts(repo, brief, lines, {
          stage: 'part-selection',
          provider: new StageScriptProvider({ 'part-selection': editBomScript() }),
        }),
      );
      expect(res.ok).toBe(true);
      expect(lines).toContain('plan (--stage part-selection): part-selection');
      expect(lines).toContain('stage part-selection: running (requested)');
      expect(lines.some((l) => l.startsWith('stale after part-selection: schematic (bom edge), outputs (bom edge)'))).toBe(true);
      expect(ranStages(lines)).toEqual(['part-selection', 'schematic', 'outputs']);
      expect(await readFile(path.join(repo, 'docs', 'BOM.md'), 'utf8')).toContain('revised by test');

      // triggers land in the run-start events (AC-8 surfaces)
      const runsDir = path.join(repo, '.copperhead', 'runs');
      const starts: { name?: string; trigger?: string; changedInputs?: string[] }[] = [];
      for (const dir of await readdir(runsDir)) {
        const jsonl = await readFile(path.join(runsDir, dir, 'transcript.jsonl'), 'utf8');
        for (const line of jsonl.split('\n').filter(Boolean)) {
          const ev = JSON.parse(line) as { type: string; data: { stage?: { name: string; trigger?: string; changedInputs?: string[] } } };
          if (ev.type === 'run-start' && ev.data.stage) starts.push(ev.data.stage);
        }
      }
      expect(starts.some((s) => s.name === 'part-selection' && s.trigger === 'requested')).toBe(true);
      expect(
        starts.some((s) => s.name === 'schematic' && s.trigger === 'stale' && s.changedInputs?.includes('bom')),
      ).toBe(true);

      // a re-run whose outputs don't change invalidates nothing
      const lines2: string[] = [];
      await runCreate(createOpts(repo, brief, lines2, { stage: 'devplan', provider: finishOnlyProvider() }));
      expect(ranStages(lines2)).toEqual(['devplan']);
      expect(lines2).toContain('stage devplan: outputs unchanged; nothing invalidated');
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('--interactive gates reconciliation on the confirm seam', async () => {
    const { repo, brief, cleanup } = await createFixture();
    try {
      await runCreate(createOpts(repo, brief, []));
      await runCreate(createOpts(repo, brief, [], { stage: 'schematic', provider: finishOnlyProvider() }));
      const lines: string[] = [];
      const res = await runCreate(
        createOpts(repo, brief, lines, {
          stage: 'part-selection',
          provider: new StageScriptProvider({ 'part-selection': editBomScript() }),
          interactive: true,
          // approve the in-run proposal gate, decline the stale-set reconciliation
          confirm: async (q: string) => !q.startsWith('Reconcile'),
        }),
      );
      expect(res.ok).toBe(true);
      expect(ranStages(lines)).toEqual(['part-selection']); // no reconciliation ran
      expect(lines.join('\n')).toContain('stale stages left unreconciled');
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('--from force-re-runs the stage and its graph descendants only', async () => {
    const { repo, brief, cleanup } = await createFixture();
    try {
      await runCreate(createOpts(repo, brief, []));
      const lines: string[] = [];
      const res = await runCreate(createOpts(repo, brief, lines, { from: 'layout-draft', provider: finishOnlyProvider() }));
      expect(res.ok).toBe(true);
      expect(lines).toContain('plan (--from layout-draft): layout-draft → outputs → devplan');
      expect(ranStages(lines)).toEqual(['layout-draft', 'outputs', 'devplan']); // never firmware
      expect(lines).toContain('stage layout-draft: running (from)');
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('--dry-run prints the classification and writes nothing', async () => {
    const { repo, brief, cleanup } = await createFixture();
    try {
      const lines: string[] = [];
      const res = await runCreate(createOpts(repo, brief, lines, { dryRun: true }));
      expect(res.ok).toBe(true);
      const out = lines.join('\n');
      for (const s of ['spec-seed', 'architecture', 'part-selection', 'schematic', 'layout-draft']) {
        expect(out).toContain(`${s}: assumed-complete`);
      }
      for (const s of ['outputs', 'firmware', 'devplan']) expect(out).toContain(`${s}: incomplete`);
      expect(out).toContain('would run (default): outputs → firmware → devplan');
      const { stdout } = await execa('git', ['status', '--porcelain'], { cwd: repo });
      expect(stdout).toBe('');
    } finally {
      await cleanup();
    }
  });

  it('--dry-run reports the stale set after an upstream edit', async () => {
    const { repo, brief, cleanup } = await createFixture();
    try {
      await runCreate(createOpts(repo, brief, []));
      await runCreate(createOpts(repo, brief, [], { stage: 'schematic', provider: finishOnlyProvider() }));
      await handEditBomRationale(repo);
      const lines: string[] = [];
      await runCreate(createOpts(repo, brief, lines, { dryRun: true }));
      const out = lines.join('\n');
      expect(out).toContain('schematic: stale (changed: bom)');
      expect(out).toContain('outputs: stale (changed: bom)');
      expect(out).toContain('would run (default): schematic → outputs');
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('a brief edit makes only the recorded spec-seed stale, and a no-op re-run cascades nowhere', async () => {
    const { repo, brief, cleanup } = await createFixture();
    try {
      await runCreate(createOpts(repo, brief, []));
      // record spec-seed so the brief edge has a recorded hash to go stale against
      await runCreate(createOpts(repo, brief, [], { stage: 'spec-seed', provider: finishOnlyProvider() }));
      await writeFile(brief, '# Brief\n\nA tiny USB-C power breakout, now with a status LED.\n', 'utf8');

      const lines: string[] = [];
      const res = await runCreate(createOpts(repo, brief, lines, { provider: finishOnlyProvider() }));
      expect(res.ok).toBe(true);
      // spec-seed is the only consumer of the brief; everything else stays put
      expect(ranStages(lines)).toEqual(['spec-seed']);
      expect(lines).toContain('stage spec-seed: running (stale: brief)');
      expect(lines.filter((l) => l.includes('fresh (skipping)')).length).toBe(3);
      expect(lines.filter((l) => l.includes('already complete (resuming past it)')).length).toBe(4);
      // the scripted stage changed no outputs, so the spec edge never fires downstream
      expect(lines).toContain('stage spec-seed: outputs unchanged; nothing invalidated');
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('--stage does not widen to pre-existing unrelated staleness; the next default run picks it up', async () => {
    const { repo, brief, cleanup } = await createFixture();
    try {
      await runCreate(createOpts(repo, brief, []));
      // record architecture so the spec edge is comparable, then hand-edit SPEC.md
      await runCreate(createOpts(repo, brief, [], { stage: 'architecture', provider: finishOnlyProvider() }));
      await writeFile(path.join(repo, 'docs', 'SPEC.md'), '# Spec\n\n## Budgets\n\n- sleep < 10 uA\n', 'utf8');

      const lines: string[] = [];
      const res = await runCreate(createOpts(repo, brief, lines, { stage: 'devplan', provider: finishOnlyProvider() }));
      expect(res.ok).toBe(true);
      expect(lines).toContain('stage devplan: running (requested)');
      expect(ranStages(lines)).toEqual(['devplan']); // architecture untouched
      expect(lines.join('\n')).not.toContain('stage architecture');

      const lines2: string[] = [];
      const res2 = await runCreate(createOpts(repo, brief, lines2, { provider: finishOnlyProvider() }));
      expect(res2.ok).toBe(true);
      expect(ranStages(lines2)).toEqual(['architecture']);
      expect(lines2).toContain('stage architecture: running (stale: spec)');
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('a refused stage returns ok:false and writes no completion record for it', async () => {
    const { repo, brief, cleanup } = await createFixture();
    try {
      const lines: string[] = [];
      const res = await runCreate(
        createOpts(repo, brief, lines, { provider: new ScriptedProvider([finishTurn('refuse')]) }),
      );
      expect(res.ok).toBe(false);
      // outputs is the first planned stage of the new fixture
      expect(res.completed).not.toContain('outputs');
      expect(lines.join('\n')).toContain('stage outputs did not complete (refused)');
      // the record rides the stage commit; a refusal never commits, so no record exists
      const { state } = await loadCreateState(repo);
      expect(state.stages['outputs']).toBeUndefined();
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('--interactive approves reconciliation through the confirm seam', async () => {
    const { repo, brief, cleanup } = await createFixture();
    try {
      await runCreate(createOpts(repo, brief, []));
      await runCreate(createOpts(repo, brief, [], { stage: 'schematic', provider: finishOnlyProvider() }));
      const questions: string[] = [];
      const lines: string[] = [];
      const res = await runCreate(
        createOpts(repo, brief, lines, {
          stage: 'part-selection',
          provider: new StageScriptProvider({ 'part-selection': editBomScript() }),
          interactive: true,
          confirm: async (q: string) => {
            questions.push(q);
            return true;
          },
        }),
      );
      expect(res.ok).toBe(true);
      expect(questions).toContain('Reconcile stale stage(s) schematic, outputs now?');
      expect(ranStages(lines)).toEqual(['part-selection', 'schematic', 'outputs']);
      expect(lines.join('\n')).not.toContain('stale stages left unreconciled');
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('a corrupt create-state.json degrades to probes with a warning, never a crash', async () => {
    const { repo, brief, cleanup } = await createFixture();
    try {
      // a full run first, so every stage's probe artifact exists on disk
      await runCreate(createOpts(repo, brief, []));
      await writeFile(createStatePath(repo), '{ not json', 'utf8');

      const lines: string[] = [];
      const res = await runCreate(createOpts(repo, brief, lines, { provider: finishOnlyProvider() }));
      expect(res.ok).toBe(true);
      expect(lines.some((l) => l.startsWith('warning:') && l.includes('create-state.json'))).toBe(true);
      // probes take over: all work products exist, so every stage is assumed-complete
      expect(lines.filter((l) => l.includes('already complete (resuming past it)')).length).toBe(8);
      expect(ranStages(lines)).toEqual([]);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('--dry-run with --from prints the descendant plan and writes nothing', async () => {
    const { repo, brief, cleanup } = await createFixture();
    try {
      const lines: string[] = [];
      const res = await runCreate(createOpts(repo, brief, lines, { dryRun: true, from: 'layout-draft' }));
      expect(res.ok).toBe(true);
      expect(lines.join('\n')).toContain('would run (--from layout-draft): layout-draft → outputs → devplan');
      expect(ranStages(lines)).toEqual([]);
      const { stdout } = await execa('git', ['status', '--porcelain'], { cwd: repo });
      expect(stdout).toBe('');
    } finally {
      await cleanup();
    }
  });

  it('a mid-cascade failure returns ok:false and the next default run re-derives the stale set', async () => {
    const { repo, brief, cleanup } = await createFixture();
    try {
      await runCreate(createOpts(repo, brief, []));
      await runCreate(createOpts(repo, brief, [], { stage: 'schematic', provider: finishOnlyProvider() }));

      // part-selection revises the BOM, then the queued schematic reconcile refuses
      const lines: string[] = [];
      const res = await runCreate(
        createOpts(repo, brief, lines, {
          stage: 'part-selection',
          provider: new StageScriptProvider({
            'part-selection': editBomScript(),
            schematic: [finishTurn('refuse')],
          }),
        }),
      );
      expect(res.ok).toBe(false);
      expect(res.completed).toEqual(['part-selection']);
      expect(lines.join('\n')).toContain('stage schematic did not complete (refused)');

      // staleness is re-derived from records + working tree, not from the failed run
      const lines2: string[] = [];
      const res2 = await runCreate(createOpts(repo, brief, lines2, { provider: finishOnlyProvider() }));
      expect(res2.ok).toBe(true);
      expect(ranStages(lines2)).toEqual(['schematic', 'outputs']);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('a --from failure mid-list stops with ok:false and the completed prefix', async () => {
    const { repo, brief, cleanup } = await createFixture();
    try {
      await runCreate(createOpts(repo, brief, []));
      const lines: string[] = [];
      const res = await runCreate(
        createOpts(repo, brief, lines, {
          from: 'layout-draft',
          provider: new StageScriptProvider({ outputs: [finishTurn('refuse')] }),
        }),
      );
      expect(res.ok).toBe(false);
      expect(res.completed).toEqual(['layout-draft']);
      expect(lines.join('\n')).toContain(
        'stage outputs did not complete (refused); a plain copperhead create resumes from here',
      );
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('targeted modes warn when an upstream stage is incomplete', async () => {
    const { repo, brief, cleanup } = await createFixture();
    try {
      // fresh fixture: firmware (devplan's only incomplete ancestor) has not run yet
      const lines: string[] = [];
      await runCreate(createOpts(repo, brief, lines, { dryRun: true, stage: 'devplan' }));
      expect(lines).toContain(
        'warning: upstream stage(s) firmware are incomplete; devplan may run against missing inputs',
      );
    } finally {
      await cleanup();
    }
  });

  it('--dry-run with --stage prints the targeted plan and writes nothing', async () => {
    const { repo, brief, cleanup } = await createFixture();
    try {
      const lines: string[] = [];
      const res = await runCreate(createOpts(repo, brief, lines, { dryRun: true, stage: 'schematic' }));
      expect(res.ok).toBe(true);
      expect(res.completed).toEqual([]);
      expect(lines.join('\n')).toContain('would run (--stage schematic): schematic');
      expect(ranStages(lines)).toEqual([]);
      const { stdout } = await execa('git', ['status', '--porcelain'], { cwd: repo });
      expect(stdout).toBe('');
      expect(existsSync(createStatePath(repo))).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

describe('probe-gated records and demotion (adversarial-review fixes)', () => {
  it('a committed run that produced nothing stays unrecorded and re-runs next time', async () => {
    const { repo, brief, cleanup } = await createFixture();
    try {
      const lines: string[] = [];
      const res = await runCreate(createOpts(repo, brief, lines, { provider: finishOnlyProvider() }));
      expect(res.ok).toBe(true);
      expect(ranStages(lines)).toEqual(['outputs', 'firmware', 'devplan']);
      // each stage committed (changelog) but met no completion contract
      expect(lines.filter((l) => l.includes('completion contract is not met')).length).toBe(3);
      const { state } = await loadCreateState(repo);
      expect(Object.keys(state.stages)).toEqual([]);

      // nothing was recorded and nothing exists, so the same three stages re-run
      const lines2: string[] = [];
      await runCreate(createOpts(repo, brief, lines2, { provider: finishOnlyProvider() }));
      expect(ranStages(lines2)).toEqual(['outputs', 'firmware', 'devplan']);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('a record never outranks a failing probe: deleting firmware/ re-runs the stage (AC-9.9)', async () => {
    const { repo, brief, cleanup } = await createFixture();
    try {
      await runCreate(createOpts(repo, brief, []));
      await rm(path.join(repo, 'firmware'), { recursive: true, force: true });

      const lines: string[] = [];
      const res = await runCreate(createOpts(repo, brief, lines)); // recreates pins.h byte-identically
      expect(res.ok).toBe(true);
      // firmware demotes to incomplete (first-time trigger, no stale note) and re-runs
      expect(lines).toContain('stage firmware: running');
      expect(ranStages(lines)).toEqual(['firmware']);
      expect(existsSync(path.join(repo, 'firmware', 'pins.h'))).toBe(true);
      // devplan was queued stale (firmware edge) but the re-run restored the exact
      // bytes, so it turns fresh before popping and is skipped with a log line
      expect(lines).toContain(
        'stage devplan: became fresh before running (inputs restored by an earlier stage); skipping',
      );
      const { state } = await loadCreateState(repo);
      expect(state.stages['firmware']).toBeDefined();

      const lines2: string[] = [];
      await runCreate(createOpts(repo, brief, lines2));
      expect(ranStages(lines2)).toEqual([]);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('targeted modes print the plan and warn when the working tree is dirty', async () => {
    const { repo, brief, cleanup } = await createFixture();
    try {
      await writeFile(path.join(repo, 'scratch.txt'), 'uncommitted WIP\n', 'utf8');
      const lines: string[] = [];
      const res = await runCreate(createOpts(repo, brief, lines, { stage: 'devplan', provider: finishOnlyProvider() }));
      expect(res.ok).toBe(true);
      expect(lines).toContain('plan (--stage devplan): devplan');
      expect(lines).toContain(
        'warning: working tree is dirty; uncommitted changes will be included in the re-run stage commit(s)',
      );
    } finally {
      await cleanup();
    }
  }, 120_000);
});

describe('stage prompt preambles', () => {
  it('first runs get the bare prompt; stale and requested re-runs get the matching preamble', async () => {
    const { repo, brief, cleanup } = await createFixture();
    try {
      // first-time (incomplete) stage: no re-run preamble of either kind
      const first = fullRunProvider();
      await runCreate(createOpts(repo, brief, [], { provider: first }));
      const outputsPrompt = first.promptFor('outputs');
      expect(outputsPrompt).toBeDefined();
      expect(outputsPrompt).toContain('Stage 6: outputs package');
      expect(outputsPrompt).not.toContain('completed previously'); // both preambles open with this

      // stale re-run: reconciliation preamble names the changed artifact and its location
      await runCreate(createOpts(repo, brief, [], { stage: 'schematic', provider: finishOnlyProvider() }));
      await handEditBomRationale(repo);
      const stale = finishOnlyProvider();
      await runCreate(createOpts(repo, brief, [], { provider: stale }));
      const schematic = stale.promptFor('schematic');
      expect(schematic).toBeDefined();
      expect(schematic).toContain('upstream artifacts it depends on have changed');
      expect(schematic).toContain('- bom (docs/BOM.md)');
      expect(schematic).toContain('do not recreate them from scratch');

      // --stage re-run of a completed (fresh) stage: revise-in-place instruction
      const requested = finishOnlyProvider();
      await runCreate(createOpts(repo, brief, [], { provider: requested, stage: 'devplan' }));
      const devplan = requested.promptFor('devplan');
      expect(devplan).toBeDefined();
      expect(devplan).toContain('deliberately re-run');
      expect(devplan).toContain('do not recreate them');
      expect(devplan).not.toContain('upstream artifacts'); // requested, not stale
    } finally {
      await cleanup();
    }
  }, 120_000);
});

describe('stage re-run metadata on the human surfaces (task 7.2)', () => {
  it('the CLI header and summary carry the trigger and changed inputs', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const lines: string[] = [];
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'surface test',
        model: 'gpt-5',
        maxTurns: 1,
        provider: new ScriptedProvider([turn([{ name: 'bogus', args: {} }])]),
        log: (l) => lines.push(l),
        meta: {
          command: 'create',
          modelSource: 'flag',
          stage: { name: 'schematic', index: 4, total: 8, trigger: 'stale', changedInputs: ['bom'] },
        },
      });
      expect(lines.join('\n')).toContain('stage schematic (4/8, stale: bom)');
      const summary = await readFile(path.join(res.transcriptDir, 'summary.md'), 'utf8');
      expect(summary).toContain('**Stage:** schematic (4/8, stale: bom)');
    } finally {
      await cleanup();
    }
  });
});
