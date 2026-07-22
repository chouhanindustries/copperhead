import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import {
  ABSENT,
  hashArtifact,
  loadCreateState,
  saveStageRecord,
  createStatePath,
  classifyStages,
  type ArtifactName,
} from '../src/memory/stagestate.js';
import { tempFixtureRepo } from './helpers.js';

const CONFIG = { schematic: 'hardware/open-key.kicad_sch', board: null, docs: 'docs/' };
const NO_KICAD = { schematic: null, board: null, docs: 'docs/' };

describe('artifact hashing (design D2)', () => {
  it('a single-doc artifact hashes its content and reacts to edits', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      expect(await hashArtifact('bom', repo, CONFIG)).toBe(ABSENT);
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(path.join(repo, 'docs', 'BOM.md'), '| R1 | 10k |\n', 'utf8');
      const h1 = await hashArtifact('bom', repo, CONFIG);
      expect(h1).not.toBe(ABSENT);
      expect(await hashArtifact('bom', repo, CONFIG)).toBe(h1); // stable across reads
      await writeFile(path.join(repo, 'docs', 'BOM.md'), '| R1 | 4.7k |\n', 'utf8');
      expect(await hashArtifact('bom', repo, CONFIG)).not.toBe(h1);
    } finally {
      await cleanup();
    }
  });

  it('the schematic artifact covers every .kicad_sch under the schematic directory', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      expect(await hashArtifact('schematic', repo, NO_KICAD)).toBe(ABSENT); // unconfigured
      const h1 = await hashArtifact('schematic', repo, CONFIG);
      expect(h1).not.toBe(ABSENT);
      // a hierarchical sub-sheet appearing next to the root sheet changes the hash
      await writeFile(path.join(repo, 'hardware', 'power.kicad_sch'), '(kicad_sch)\n', 'utf8');
      const h2 = await hashArtifact('schematic', repo, CONFIG);
      expect(h2).not.toBe(h1);
      expect(h2).not.toBe(ABSENT);
    } finally {
      await cleanup();
    }
  });

  it('the spec artifact spans SPEC.md and constraints.json', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      expect(await hashArtifact('spec', repo, CONFIG)).toBe(ABSENT); // both missing
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(path.join(repo, 'docs', 'SPEC.md'), '## Budgets\n- sleep_current_uA: 25\n', 'utf8');
      const h1 = await hashArtifact('spec', repo, CONFIG);
      expect(h1).not.toBe(ABSENT);
      // a constraint recorded later changes the spec artifact
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(path.join(repo, '.copperhead', 'constraints.json'), '{"k":{"max":1,"source":"s","affects":[]}}\n', 'utf8');
      expect(await hashArtifact('spec', repo, CONFIG)).not.toBe(h1);
    } finally {
      await cleanup();
    }
  });

  it('the spec artifact is present when only constraints.json exists', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      // a constraint recorded before SPEC.md is scaffolded must still count as spec content
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(path.join(repo, '.copperhead', 'constraints.json'), '{"k":{"max":1,"source":"s","affects":[]}}\n', 'utf8');
      const h = await hashArtifact('spec', repo, CONFIG);
      expect(h).not.toBe(ABSENT);
      expect(await hashArtifact('spec', repo, CONFIG)).toBe(h); // stable across reads
    } finally {
      await cleanup();
    }
  });

  it('the schematic artifact ignores non-.kicad_sch files in the same directory', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const h1 = await hashArtifact('schematic', repo, CONFIG);
      // the board lives next to the sheet in the fixture; editing it must not perturb the schematic artifact
      await writeFile(path.join(repo, 'hardware', 'open-key.kicad_pcb'), '(kicad_pcb (net 1 "GND"))\n', 'utf8');
      expect(await hashArtifact('schematic', repo, CONFIG)).toBe(h1);
    } finally {
      await cleanup();
    }
  });

  it('directory artifacts include nested files recursively and are path-sensitive', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, 'outputs', 'gerbers'), { recursive: true });
      await writeFile(path.join(repo, 'outputs', 'bom.csv'), 'R1,10k\n', 'utf8');
      const flat = await hashArtifact('outputs', repo, CONFIG);
      expect(flat).not.toBe(ABSENT);
      // a file two levels down participates
      await writeFile(path.join(repo, 'outputs', 'gerbers', 'top.gbr'), 'G04 top*\n', 'utf8');
      const nested = await hashArtifact('outputs', repo, CONFIG);
      expect(nested).not.toBe(flat);
      // same bytes at a different relative path is a different artifact state
      await rename(
        path.join(repo, 'outputs', 'gerbers', 'top.gbr'),
        path.join(repo, 'outputs', 'gerbers', 'bottom.gbr'),
      );
      expect(await hashArtifact('outputs', repo, CONFIG)).not.toBe(nested);
    } finally {
      await cleanup();
    }
  });

  it('renaming the only file under a directory artifact changes the hash', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, 'outputs'), { recursive: true });
      await writeFile(path.join(repo, 'outputs', 'top.gbr'), 'G04 top*\n', 'utf8');
      const h1 = await hashArtifact('outputs', repo, CONFIG);
      await rename(path.join(repo, 'outputs', 'top.gbr'), path.join(repo, 'outputs', 'bottom.gbr'));
      expect(await hashArtifact('outputs', repo, CONFIG)).not.toBe(h1);
    } finally {
      await cleanup();
    }
  });
});

describe('create-state records', () => {
  it('round-trips a stage record', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await saveStageRecord(repo, 'part-selection', {
        completedAt: '2026-07-21T00:00:00.000Z',
        runId: 'run-1',
        inputs: { spec: 'aaa' },
        outputs: { bom: 'bbb' },
      });
      const { state, warning } = await loadCreateState(repo);
      expect(warning).toBeNull();
      expect(state.stages['part-selection']!.inputs.spec).toBe('aaa');
      expect(state.stages['part-selection']!.outputs.bom).toBe('bbb');
    } finally {
      await cleanup();
    }
  });

  it('a parseable record with a missing shape degrades to unrecorded, never a crash (AC-9.8)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      // hand edit / partial write: schematic's record lost its fields
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(
        createStatePath(repo),
        JSON.stringify({
          version: 1,
          stages: {
            schematic: {},
            'part-selection': { completedAt: 't', runId: 'r', inputs: { spec: 'aaa' }, outputs: {} },
          },
        }),
        'utf8',
      );
      const { state, warning } = await loadCreateState(repo);
      expect(warning).toContain('schematic');
      expect(state.stages['schematic']).toBeUndefined(); // demoted to unrecorded
      expect(state.stages['part-selection']).toBeDefined(); // valid sibling survives

      // classification must not throw on the malformed record (the reproduced TypeError)
      const res = await classifyStages({
        repoRoot: repo,
        config: CONFIG,
        stages: [{ name: 'schematic', consumes: ['bom'] as ArtifactName[], isComplete: () => true }],
      });
      expect(res.classifications[0]!.status).toBe('assumed-complete'); // probe decides, hashes never touched
    } finally {
      await cleanup();
    }
  });

  it('an unsupported version degrades to no records with a warning', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(createStatePath(repo), JSON.stringify({ version: 2, stages: {} }), 'utf8');
      const { state, warning } = await loadCreateState(repo);
      expect(state.stages).toEqual({});
      expect(warning).toContain('version');
    } finally {
      await cleanup();
    }
  });

  it('a corrupt state file degrades to no records with a warning, never a throw', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(createStatePath(repo), '{not json', 'utf8');
      const { state, warning } = await loadCreateState(repo);
      expect(state.stages).toEqual({});
      expect(warning).toContain('create-state.json');
    } finally {
      await cleanup();
    }
  });

  it('a well-formed JSON file with the wrong shape degrades to no records with a warning', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      // parseable but shape-invalid: stages not a map, top-level array, top-level null
      for (const bad of ['{"stages": 42}', '[]', 'null']) {
        await writeFile(createStatePath(repo), bad, 'utf8');
        const { state, warning } = await loadCreateState(repo);
        expect(state.stages).toEqual({});
        expect(warning).toContain('create-state.json');
      }
    } finally {
      await cleanup();
    }
  });

  it('saveStageRecord keeps other stages intact and overwrites the same stage', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const at = '2026-07-21T00:00:00.000Z';
      await saveStageRecord(repo, 'part-selection', { completedAt: at, runId: 'run-1', inputs: { spec: 'aaa' }, outputs: {} });
      await saveStageRecord(repo, 'schematic-capture', { completedAt: at, runId: 'run-2', inputs: {}, outputs: { schematic: 'ccc' } });
      let { state } = await loadCreateState(repo);
      expect(Object.keys(state.stages).sort()).toEqual(['part-selection', 'schematic-capture']);
      // re-running a stage replaces only its own record
      await saveStageRecord(repo, 'part-selection', { completedAt: at, runId: 'run-3', inputs: { spec: 'ddd' }, outputs: {} });
      ({ state } = await loadCreateState(repo));
      expect(state.stages['part-selection']!.runId).toBe('run-3');
      expect(state.stages['part-selection']!.inputs.spec).toBe('ddd');
      expect(state.stages['schematic-capture']!.outputs.schematic).toBe('ccc');
    } finally {
      await cleanup();
    }
  });
});

describe('staleness classification (design D4)', () => {
  const stagesFor = (repo: string, complete: boolean) => [
    { name: 'part-selection', consumes: ['spec'] as ArtifactName[], isComplete: () => complete },
  ];

  it('no record: the completion probe decides incomplete vs assumed-complete', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const incomplete = await classifyStages({ repoRoot: repo, config: CONFIG, stages: stagesFor(repo, false) });
      expect(incomplete.classifications[0]!.status).toBe('incomplete');
      const assumed = await classifyStages({ repoRoot: repo, config: CONFIG, stages: stagesFor(repo, true) });
      expect(assumed.classifications[0]!.status).toBe('assumed-complete');
    } finally {
      await cleanup();
    }
  });

  it('recorded matching inputs are fresh; an upstream edit flips to stale naming the artifact', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(path.join(repo, 'docs', 'SPEC.md'), '## Budgets\n- x: 1\n', 'utf8');
      const specHash = await hashArtifact('spec', repo, CONFIG);
      await saveStageRecord(repo, 'part-selection', {
        completedAt: '2026-07-21T00:00:00.000Z',
        runId: 'run-1',
        inputs: { spec: specHash },
        outputs: {},
      });

      const fresh = await classifyStages({ repoRoot: repo, config: CONFIG, stages: stagesFor(repo, true) });
      expect(fresh.classifications[0]).toMatchObject({ status: 'fresh', changedInputs: [] });

      await writeFile(path.join(repo, 'docs', 'SPEC.md'), '## Budgets\n- x: 2\n', 'utf8');
      const stale = await classifyStages({ repoRoot: repo, config: CONFIG, stages: stagesFor(repo, true) });
      expect(stale.classifications[0]).toMatchObject({ status: 'stale', changedInputs: ['spec'] });
    } finally {
      await cleanup();
    }
  });

  it('changed inputs outrank a failing probe for recorded stages (drift-aware probes)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(path.join(repo, 'docs', 'SPEC.md'), '## Budgets\n- x: 1\n', 'utf8');
      await saveStageRecord(repo, 'part-selection', {
        completedAt: '2026-07-22T00:00:00.000Z',
        runId: 'run-1',
        inputs: { spec: await hashArtifact('spec', repo, CONFIG) },
        outputs: {},
      });
      await writeFile(path.join(repo, 'docs', 'SPEC.md'), '## Budgets\n- x: 2\n', 'utf8');
      // the probe fails BECAUSE the upstream artifact changed (drift-aware);
      // classification must keep the stale trigger and the changed-input name
      const res = await classifyStages({ repoRoot: repo, config: CONFIG, stages: stagesFor(repo, false) });
      expect(res.classifications[0]).toMatchObject({ status: 'stale', changedInputs: ['spec'] });
    } finally {
      await cleanup();
    }
  });

  it('a recorded stage with matching inputs and a failing probe is incomplete (AC-9.9)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await saveStageRecord(repo, 'part-selection', {
        completedAt: '2026-07-22T00:00:00.000Z',
        runId: 'run-1',
        inputs: { spec: await hashArtifact('spec', repo, CONFIG) }, // ABSENT, still ABSENT
        outputs: {},
      });
      const res = await classifyStages({ repoRoot: repo, config: CONFIG, stages: stagesFor(repo, false) });
      expect(res.classifications[0]!.status).toBe('incomplete'); // work product gone, not "fresh"
    } finally {
      await cleanup();
    }
  });

  it('a consumed artifact with no recorded hash counts as changed', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await saveStageRecord(repo, 'part-selection', {
        completedAt: '2026-07-21T00:00:00.000Z',
        runId: 'run-1',
        inputs: {}, // consumes grew since this record was written
        outputs: {},
      });
      const res = await classifyStages({ repoRoot: repo, config: CONFIG, stages: stagesFor(repo, true) });
      // current spec hash is ABSENT, record has nothing for it → changed
      expect(res.classifications[0]!.status).toBe('stale');
    } finally {
      await cleanup();
    }
  });

  it('a stage consuming the brief goes stale when the brief file is edited', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, 'Build a macropad.\n', 'utf8');
      const briefHash = await hashArtifact('brief', repo, CONFIG, briefPath);
      expect(briefHash).not.toBe(ABSENT);
      await saveStageRecord(repo, 'requirements', {
        completedAt: '2026-07-21T00:00:00.000Z',
        runId: 'run-1',
        inputs: { brief: briefHash },
        outputs: {},
      });
      const stages = [{ name: 'requirements', consumes: ['brief'] as ArtifactName[], isComplete: () => true }];

      const fresh = await classifyStages({ repoRoot: repo, config: CONFIG, briefPath, stages });
      expect(fresh.classifications[0]).toMatchObject({ status: 'fresh', changedInputs: [] });

      await writeFile(briefPath, 'Build a macropad with a rotary encoder.\n', 'utf8');
      const stale = await classifyStages({ repoRoot: repo, config: CONFIG, briefPath, stages });
      expect(stale.classifications[0]).toMatchObject({ status: 'stale', changedInputs: ['brief'] });
    } finally {
      await cleanup();
    }
  });

  it('an artifact appearing or disappearing relative to the record classifies as stale', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const at = '2026-07-21T00:00:00.000Z';
      const stages = [{ name: 'part-selection', consumes: ['bom'] as ArtifactName[], isComplete: () => true }];

      // the ABSENT sentinel round-trips: recorded-absent + still-absent matches
      await saveStageRecord(repo, 'part-selection', { completedAt: at, runId: 'run-1', inputs: { bom: ABSENT }, outputs: {} });
      const still = await classifyStages({ repoRoot: repo, config: CONFIG, stages });
      expect(still.classifications[0]!.status).toBe('fresh');

      // appearance: ABSENT → real hash
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(path.join(repo, 'docs', 'BOM.md'), '| R1 | 10k |\n', 'utf8');
      const appeared = await classifyStages({ repoRoot: repo, config: CONFIG, stages });
      expect(appeared.classifications[0]).toMatchObject({ status: 'stale', changedInputs: ['bom'] });

      // disappearance: real hash → ABSENT
      await saveStageRecord(repo, 'part-selection', {
        completedAt: at,
        runId: 'run-2',
        inputs: { bom: await hashArtifact('bom', repo, CONFIG) },
        outputs: {},
      });
      await rm(path.join(repo, 'docs', 'BOM.md'));
      const gone = await classifyStages({ repoRoot: repo, config: CONFIG, stages });
      expect(gone.classifications[0]).toMatchObject({ status: 'stale', changedInputs: ['bom'] });
    } finally {
      await cleanup();
    }
  });
});
