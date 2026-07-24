import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import type { Msg, Provider, ToolCall, ToolSchema, Turn } from '../src/agent/types.js';
import { CachingProvider } from '../src/agent/response-cache.js';
import { runCreate, STAGES, type CreateOptions } from '../src/commands/create.js';
import { runCheck } from '../src/commands/check.js';
import { listSymbols } from '../src/kicad/sexp.js';
import { FIXTURE } from './helpers.js';

/**
 * These are recorded model responses, not a mocked agent loop. runCreate still
 * executes the production runAgentLoop, tool dispatcher, OpenSpec lock, KiCad
 * load probes, ERC/DRC, drift gates, git commits, stage contracts, and final
 * runCheck. Replaying fixed turns keeps this acceptance path deterministic and
 * network-free while ensuring a broken production gate makes the test red.
 */
class RecordedProvider implements Provider {
  readonly name = 'recorded-replay';
  private cursor = 0;

  constructor(private readonly turns: Turn[]) {}

  async chat(_messages: Msg[], _tools: ToolSchema[]): Promise<Turn> {
    const turn = this.turns[this.cursor++];
    if (!turn) throw new Error(`recorded replay exhausted after ${this.cursor - 1} turn(s)`);
    return turn;
  }
}

class CacheMissProvider implements Provider {
  readonly name = 'recorded-replay';
  calls = 0;

  async chat(): Promise<Turn> {
    this.calls++;
    throw new Error('deterministic replay missed the on-disk response cache');
  }
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const schematic = readFileSync(path.join(FIXTURE, 'hardware', 'open-key.kicad_sch'), 'utf8');
const bareBoard = readFileSync(path.join(FIXTURE, 'hardware', 'open-key.kicad_pcb'), 'utf8');
const board = bareBoard.replace(
  /\n\)\s*$/,
  `
  (footprint "Acceptance_Marker"
    (layer "F.Cu")
    (uuid "2a2a2a2a-0000-4000-8000-000000000001")
    (at 110 110)
    (property "Reference" "REF**"
      (at 0 -2 0)
      (layer "F.SilkS")
      (uuid "2a2a2a2a-0000-4000-8000-000000000002")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (property "Value" "Acceptance_Marker"
      (at 0 2 0)
      (layer "F.Fab")
      (uuid "2a2a2a2a-0000-4000-8000-000000000003")
      (effects (font (size 1 1) (thickness 0.15)))
    )
    (attr board_only exclude_from_pos_files exclude_from_bom allow_missing_courtyard)
    (fp_line
      (start -1 -1)
      (end 1 -1)
      (stroke (width 0.2) (type default))
      (layer "F.SilkS")
      (uuid "2a2a2a2a-0000-4000-8000-000000000004")
    )
    (embedded_fonts no)
  )
)
`,
);
const wedgedSchematic = schematic.replace(
  '  (no_connect (at 127 96.52) (uuid "0b0b0b0b-0000-4000-8000-000000000001"))\n',
  '',
);

const spec = `# Replay board specification

## Budgets

- Deterministic acceptance fixture; no external model calls.
`;

const subsystems = `# Subsystems

## Controller

The embedded ESP32 module is represented by U1.
`;

const bom = `# Bill of Materials

| Refdes | Value | Footprint | MPN | Rationale |
|---|---|---|---|---|
| R1 | 10k | Resistor_SMD:R_0603_1608Metric | TEST-R-10K | replay fixture |
| R2 | 1k | Resistor_SMD:R_0603_1608Metric | TEST-R-1K | replay fixture |
| U1 | ESP32-S3-MINI | RF_Module:ESP32-S3-MINI-1 | TEST-ESP32 | replay fixture |
`;

const pinout = `# Pinout

| Refdes | Pin | Name | Net | Notes |
|---|---|---|---|---|
| R1 | 1 | ~ | 3V3 | |
| R1 | 2 | ~ | EN | |
| R2 | 1 | ~ | KEY_DAH | |
| R2 | 2 | ~ | GND | |
| U1 | 1 | 3V3 | 3V3 | |
| U1 | 2 | EN | EN | |
| U1 | 3 | GPIO0 | | NC |
| U1 | 4 | GPIO3 | | NC |
| U1 | 5 | GPIO14 | KEY_DAH | |
| U1 | 6 | GPIO18 | | NC |
| U1 | 7 | GPIO21 | | NC |
| U1 | 8 | GND | GND | |
`;

function call(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, name, args };
}

function recorded(...toolCalls: ToolCall[]): Turn {
  return {
    text: 'Recorded acceptance response.',
    toolCalls,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function proposal(stage: string): Turn {
  return recorded(
    call(`${stage}-proposal`, 'propose_change', {
      id: `replay-${stage}`,
      why: `Deterministically exercise the ${stage} stage.`,
      what_changes: `- Produce the ${stage} acceptance artifact.`,
      tasks: `- [ ] Produce and verify the ${stage} acceptance artifact.`,
    }),
    call(`${stage}-validate`, 'validate_change'),
  );
}

function finish(stage: string, ...work: ToolCall[]): Turn {
  return recorded(
    ...work,
    call(`${stage}-drift`, 'check_drift'),
    call(`${stage}-finish`, 'finish', {
      outcome: 'done',
      summary: `${stage} replay completed through production gates`,
    }),
  );
}

function successTurns(stage: string): Turn[] {
  switch (stage) {
    case 'spec-seed':
      return [
        proposal(stage),
        finish(stage, call('spec-write', 'write_file', { path: 'docs/SPEC.md', content: spec })),
      ];
    case 'architecture':
      return [
        proposal(stage),
        finish(
          stage,
          call('subsystems-write', 'write_file', {
            path: 'docs/SUBSYSTEMS.md',
            content: subsystems,
          }),
        ),
      ];
    case 'part-selection':
      return [
        proposal(stage),
        finish(stage, call('bom-write', 'write_file', { path: 'docs/BOM.md', content: bom })),
      ];
    case 'schematic':
      return [
        proposal(stage),
        finish(
          stage,
          call('schematic-read', 'read_file', { path: 'replay-board.kicad_sch' }),
          call('schematic-edit', 'edit_file', {
            path: 'replay-board.kicad_sch',
            old_string: '__CURRENT_SCHEMATIC__',
            new_string: schematic,
          }),
          call('pinout-write', 'write_file', { path: 'docs/PINOUT.md', content: pinout }),
          call('schematic-erc', 'run_erc'),
        ),
      ];
    case 'layout-draft':
      return [
        proposal(stage),
        finish(
          stage,
          call('board-read', 'read_file', { path: 'replay-board.kicad_pcb' }),
          call('board-edit', 'edit_file', {
            path: 'replay-board.kicad_pcb',
            old_string: '__CURRENT_BOARD__',
            new_string: board,
          }),
          call('layout-write', 'write_file', {
            path: 'docs/LAYOUT.md',
            content: '# Layout\n\n## Draft quality\n\nAcceptance fixture placement only.\n',
          }),
          call('layout-erc', 'run_erc'),
          call('layout-drc', 'run_drc'),
        ),
      ];
    case 'outputs':
      return [proposal(stage), finish(stage, call('outputs-export', 'export_outputs'))];
    case 'firmware':
      return [
        proposal(stage),
        finish(
          stage,
          call('firmware-write', 'write_file', {
            path: 'firmware/pins.h',
            content: '#pragma once\n#define KEY_DAH_GPIO 14\n',
          }),
        ),
      ];
    case 'devplan':
      return [
        proposal(stage),
        finish(
          stage,
          call('devplan-write', 'write_file', {
            path: 'docs/DEVPLAN.md',
            content: '# Development plan\n\n1. Inspect rails.\n2. Flash the replay firmware.\n',
          }),
        ),
      ];
    default:
      throw new Error(`no recorded turns for stage ${stage}`);
  }
}

/**
 * The only substitutions are exact snapshots of the deterministic KiCad files
 * scaffolded by runCreate. The recorded edit still goes through edit_file and
 * its real kicad-cli loadability probe.
 */
class MaterializedRecordedProvider extends RecordedProvider {
  constructor(stage: string, repo: string, turns = successTurns(stage)) {
    super(
      turns.map((turn) => ({
        ...turn,
        toolCalls: turn.toolCalls.map((toolCall) => {
          if (toolCall.args.old_string === '__CURRENT_SCHEMATIC__') {
            return {
              ...toolCall,
              args: {
                ...toolCall.args,
                old_string: readFileSync(path.join(repo, 'replay-board.kicad_sch'), 'utf8'),
              },
            };
          }
          if (toolCall.args.old_string === '__CURRENT_BOARD__') {
            return {
              ...toolCall,
              args: {
                ...toolCall.args,
                old_string: readFileSync(path.join(repo, 'replay-board.kicad_pcb'), 'utf8'),
              },
            };
          }
          return toolCall;
        }),
      })),
    );
  }
}

async function replayRepo(): Promise<{ repo: string; briefPath: string }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-create-replay-'));
  cleanups.push(() => rm(repo, { recursive: true, force: true }));
  await mkdir(path.join(repo, '.copperhead'), { recursive: true });
  await mkdir(path.join(repo, 'openspec'), { recursive: true });
  await writeFile(path.join(repo, 'openspec', '.gitkeep'), '', 'utf8');
  await writeFile(
    path.join(repo, '.copperhead', 'config.json'),
    JSON.stringify(
      {
        docs: 'docs/',
        maxTurns: 20,
        maxStageRetries: 0,
        maxRepairCycles: 5,
        turnTimeoutMs: 30_000,
        heartbeatMs: 0,
        llmCache: false,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  await writeFile(path.join(repo, '.gitignore'), '.copperhead/runs/\n', 'utf8');
  const briefPath = path.join(repo, 'brief.md');
  await writeFile(briefPath, '# Replay board\n', 'utf8');
  await execa('git', ['init', '-q'], { cwd: repo });
  await execa('git', ['config', 'user.email', 'replay@copperhead.local'], { cwd: repo });
  await execa('git', ['config', 'user.name', 'copperhead-replay'], { cwd: repo });
  await execa('git', ['add', '-A'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', 'replay seed'], { cwd: repo });
  return { repo, briefPath };
}

async function stageSummaries(repo: string): Promise<string[]> {
  const runs = path.join(repo, '.copperhead', 'runs');
  return (await readdir(runs, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && existsSync(path.join(runs, entry.name, 'summary.md')))
    .map((entry) => path.join(runs, entry.name, 'summary.md'))
    .sort();
}

function options(
  repo: string,
  briefPath: string,
  lines: string[],
  provider: CreateOptions['replayProvider'],
): CreateOptions {
  return {
    repoRoot: repo,
    briefPath,
    model: 'recorded-replay',
    replayProvider: provider,
    log: (line) => lines.push(line),
  };
}

describe('create pipeline deterministic end-to-end replay', () => {
  it('warms and replays all eight real stages from .copperhead/llm-cache', async () => {
    const { repo, briefPath } = await replayRepo();
    const initialSha = (await execa('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    const cacheDir = path.join(repo, '.copperhead', 'llm-cache');
    const warmLines: string[] = [];
    const warmed: string[] = [];

    const warmResult = await runCreate(
      options(repo, briefPath, warmLines, (stage) => {
        warmed.push(stage);
        return new CachingProvider(
          new MaterializedRecordedProvider(stage, repo),
          cacheDir,
          (line) => warmLines.push(line),
          'recorded-replay',
        );
      }),
    );

    expect(warmResult, warmLines.join('\n')).toEqual({
      ok: true,
      completed: STAGES.map((stage) => stage.name),
    });
    expect(warmed).toEqual(STAGES.map((stage) => stage.name));
    expect(await listSymbols(path.join(repo, 'replay-board.kicad_sch'))).toHaveLength(3);
    expect(existsSync(path.join(repo, 'replay-board.kicad_pcb'))).toBe(true);
    expect(existsSync(path.join(repo, 'outputs'))).toBe(true);
    expect(existsSync(path.join(repo, 'firmware', 'pins.h'))).toBe(true);
    expect(existsSync(path.join(repo, 'docs', 'DEVPLAN.md'))).toBe(true);
    expect((await runCheck(repo, () => {})).ok).toBe(true);
    expect(await stageSummaries(repo)).toHaveLength(8);
    expect(warmLines.join('\n')).toContain('create pipeline complete; all checks green');

    // Return only this test-created repository to its exact pre-run state.
    // `git clean` deliberately omits -x, so the ignored llm-cache survives.
    await execa('git', ['reset', '--hard', initialSha], { cwd: repo });
    await execa('git', ['clean', '-fd'], { cwd: repo });

    const replayLines: string[] = [];
    const cacheWrappers: CachingProvider[] = [];
    const missProviders: CacheMissProvider[] = [];
    const replayResult = await runCreate(
      options(repo, briefPath, replayLines, () => {
        const miss = new CacheMissProvider();
        const cached = new CachingProvider(
          miss,
          cacheDir,
          (line) => replayLines.push(line),
          'recorded-replay',
        );
        missProviders.push(miss);
        cacheWrappers.push(cached);
        return cached;
      }),
    );

    expect(replayResult, replayLines.join('\n')).toEqual({
      ok: true,
      completed: STAGES.map((stage) => stage.name),
    });
    expect(missProviders.reduce((sum, provider) => sum + provider.calls, 0)).toBe(0);
    expect(cacheWrappers.reduce((sum, provider) => sum + provider.cacheHits, 0)).toBe(16);
    expect(replayLines.filter((line) => line.includes('llm-cache: replayed'))).toHaveLength(16);
    expect(await stageSummaries(repo)).toHaveLength(16);
    expect(replayLines.join('\n')).toContain('create pipeline complete; all checks green');

    if (process.env.COPPERHEAD_E2E_EVIDENCE === '1') {
      const report = await readFile(path.join(repo, '.copperhead', 'runs', 'REPORT.md'), 'utf8');
      process.stdout.write(
        [
          '',
          '===== deterministic warm run =====',
          ...warmLines,
          '',
          '===== cache-only replay (inner provider throws on any miss) =====',
          ...replayLines,
          '',
          '===== .copperhead/runs/REPORT.md =====',
          report,
          '',
        ].join('\n'),
      );
    }
  }, 120_000);

  it('goes red when a clean ERC is only the empty scaffold', async () => {
    const { repo, briefPath } = await replayRepo();
    const lines: string[] = [];
    const requested: string[] = [];

    const result = await runCreate(
      options(repo, briefPath, lines, (stage) => {
        requested.push(stage);
        if (stage !== 'schematic') return new MaterializedRecordedProvider(stage, repo);
        return new RecordedProvider([
          proposal(stage),
          finish(stage, call('empty-erc', 'run_erc')),
        ]);
      }),
    );

    expect(result).toEqual({
      ok: false,
      completed: ['spec-seed', 'architecture', 'part-selection'],
    });
    expect(requested).toEqual(['spec-seed', 'architecture', 'part-selection', 'schematic']);
    expect(await listSymbols(path.join(repo, 'replay-board.kicad_sch'))).toHaveLength(0);
    expect(lines.join('\n')).toContain('stage completion contract is not met');
    expect(lines.join('\n')).not.toContain('create pipeline complete');
  }, 60_000);

  it('goes red when a stage wedges on a non-improving ERC result', async () => {
    const { repo, briefPath } = await replayRepo();
    const lines: string[] = [];

    const result = await runCreate(
      options(repo, briefPath, lines, (stage) => {
        if (stage !== 'schematic') return new MaterializedRecordedProvider(stage, repo);
        const work = successTurns(stage);
        const edit = work[1]!.toolCalls.find((toolCall) => toolCall.name === 'edit_file')!;
        const materializedEdit: ToolCall = {
          ...edit,
          args: {
            ...edit.args,
            old_string: readFileSync(path.join(repo, 'replay-board.kicad_sch'), 'utf8'),
            new_string: wedgedSchematic,
          },
        };
        return new RecordedProvider([
          proposal(stage),
          recorded(materializedEdit, call('wedge-erc-0', 'run_erc')),
          ...Array.from({ length: 6 }, (_, i) => recorded(call(`wedge-erc-${i + 1}`, 'run_erc'))),
        ]);
      }),
    );

    expect(result).toEqual({
      ok: false,
      completed: ['spec-seed', 'architecture', 'part-selection'],
    });
    expect(lines.join('\n')).toContain('repair cycles exhausted (5)');
    expect(lines.join('\n')).not.toContain('create pipeline complete');
  }, 60_000);

  it('goes red when the recorded run never reaches the final stage', async () => {
    const { repo, briefPath } = await replayRepo();
    const lines: string[] = [];

    const result = await runCreate(
      options(repo, briefPath, lines, (stage) =>
        stage === 'devplan'
          ? new RecordedProvider([])
          : new MaterializedRecordedProvider(stage, repo),
      ),
    );

    expect(result, lines.join('\n')).toEqual({
      ok: false,
      completed: STAGES.slice(0, -1).map((stage) => stage.name),
    });
    expect(await readFile(path.join(repo, 'firmware', 'pins.h'), 'utf8')).toContain('KEY_DAH_GPIO');
    expect(existsSync(path.join(repo, 'docs', 'DEVPLAN.md'))).toBe(false);
    expect(lines.join('\n')).toContain('recorded replay exhausted');
    expect(lines.join('\n')).not.toContain('create pipeline complete');
  }, 120_000);
});
