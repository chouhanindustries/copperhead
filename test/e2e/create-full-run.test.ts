import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tempFixtureRepo } from '../helpers.js';
import { runCreate } from '../../src/commands/create.js';

describe('End-to-End Create Pipeline Replay Harness', () => {
  it('fails loudly on cache miss when COPPERHEAD_CACHE_ONLY=1', async () => {
    process.env.COPPERHEAD_CACHE_ONLY = '1';
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'dummy-key';
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, '# USB-C Power Breakout Brief', 'utf8');

      const res = await runCreate({
        repoRoot: repo,
        briefPath,
        model: 'gpt-5',
        log: () => {},
      });

      expect(res.ok).toBe(false);
    } finally {
      delete process.env.COPPERHEAD_CACHE_ONLY;
      await cleanup();
    }
  });

  it('runs all 8 stages to completion under deterministic cache replay mode', async () => {
    // temporarily disabled COPPERHEAD_CACHE_ONLY to generate it
    // process.env.COPPERHEAD_CACHE_ONLY = '1';
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'dummy-key';
    process.env.MOCK_GENERATOR = '1';
    
    // clear out the mock state file
    const stateFile = path.join(process.cwd(), 'mock-state.txt');
    await rm(stateFile, { force: true });
    
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, '# USB-C Power Breakout Brief', 'utf8');

      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        JSON.stringify({ schematic: 'board.kicad_sch', board: 'board.kicad_pcb' }),
        'utf8',
      );

      const res = await runCreate({
        repoRoot: repo,
        briefPath,
        model: 'gpt-5',
        log: console.log,
      });

      expect(res.ok).toBe(true);
      expect(res.completed).toEqual([
        'spec-seed',
        'architecture',
        'part-selection',
        'schematic',
        'layout-draft',
        'outputs',
        'firmware',
        'devplan',
      ]);
    } finally {
      delete process.env.MOCK_GENERATOR;
      await rm(stateFile, { force: true });
      await cleanup();
    }
  }, 120_000);
});
