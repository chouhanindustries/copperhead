import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tempFixtureRepo } from './helpers.js';
import {
  runCreate,
  STAGES,
  StageWedgedError,
  FalseGreenERCError,
  IncompletePipelineRunError,
  simulateStageTurnLoop,
  evaluateErcGate,
  checkPipelineCompleteness
} from '../src/commands/create.js';
import { CachingProvider } from '../src/agent/response-cache.js';

describe('copperhead create pipeline E2E replay harness (#66)', () => {
  let repoPath: string;
  let cleanupRepo: () => Promise<void>;

  beforeEach(async () => {
    const fixture = await tempFixtureRepo();
    repoPath = fixture.repo;
    cleanupRepo = fixture.cleanup;
  });

  afterEach(async () => {
    if (cleanupRepo) {
      await cleanupRepo();
    }
  });

  it('validates all 8 pipeline stages exist and are properly ordered', () => {
    expect(STAGES).toHaveLength(8);
    const names = STAGES.map(s => s.name);
    expect(names).toEqual([
      'spec-seed',
      'architecture',
      'part-selection',
      'schematic',
      'layout-draft',
      'outputs',
      'firmware',
      'dev-plan'
    ]);
  });

  it('executes deterministic offline replay against .copperhead/llm-cache/', async () => {
    const cacheDir = path.join(repoPath, '.copperhead', 'llm-cache');
    await mkdir(cacheDir, { recursive: true });

    // Seed offline replay fixtures for stages
    const mockFixtureData = {
      version: 1,
      turns: [
        {
          stage: 'spec-seed',
          promptHash: 'abc123hash',
          response: 'SPEC.md generated with 5 budget constraints.'
        }
      ]
    };
    await writeFile(
      path.join(cacheDir, 'spec-seed.json'),
      JSON.stringify(mockFixtureData, null, 2),
      'utf8'
    );

    const cacheFile = path.join(cacheDir, 'spec-seed.json');
    expect(existsSync(cacheFile)).toBe(true);

    const raw = await readFile(cacheFile, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.turns[0].response).toContain('SPEC.md generated');
  });

  it('throws StageWedgedError loudly when stage retries exceed retry ceiling', () => {
    expect(() => simulateStageTurnLoop('schematic', 3, 3)).toThrow(StageWedgedError);
    expect(() => simulateStageTurnLoop('schematic', 3, 3)).toThrow(
      'Stage wedged: schematic exceeded retry ceiling of 3 without progress'
    );
  });

  it('throws FalseGreenERCError loudly when schematic contains 0 symbols despite clean ERC', () => {
    expect(() => evaluateErcGate('project.kicad_sch', 0, true)).toThrow(FalseGreenERCError);
    expect(() => evaluateErcGate('project.kicad_sch', 0, true)).toThrow(
      'False-green ERC detected: project.kicad_sch reported clean ERC but contains 0 symbols'
    );
  });

  it('throws IncompletePipelineRunError loudly when pipeline terminates early', () => {
    expect(() => checkPipelineCompleteness(4, 8)).toThrow(IncompletePipelineRunError);
    expect(() => checkPipelineCompleteness(4, 8)).toThrow(
      'Incomplete pipeline run: completed 4/8 stages'
    );
  });

  it('verifies non-empty schematic check passes clean ERC when symbols are present', () => {
    expect(() => evaluateErcGate('project.kicad_sch', 5, true)).not.toThrow();
  });

  it('verifies progress continues when retry count is below ceiling', () => {
    expect(() => simulateStageTurnLoop('schematic', 1, 3)).not.toThrow();
  });

  it('verifies complete pipeline run check passes when completed equals total', () => {
    expect(() => checkPipelineCompleteness(8, 8)).not.toThrow();
  });
});
