import { describe, it, expect, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tempFixtureRepo } from './helpers.js';
import { runInit } from '../src/memory/scaffold.js';

const mocks = vi.hoisted(() => ({
  runAgentLoop: vi.fn(),
  openspecInit: vi.fn(),
  runCheck: vi.fn(),
}));

vi.mock('../src/agent/loop.js', () => ({ runAgentLoop: mocks.runAgentLoop }));
vi.mock('../src/openspec/cli.js', () => ({ openspecInit: mocks.openspecInit }));
vi.mock('../src/commands/check.js', () => ({ runCheck: mocks.runCheck }));

import { runCreate, STAGES } from '../src/commands/create.js';

const stage = (name: string) => {
  const found = STAGES.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`stage ${name} not found`);
  return found;
};

const blankSchematic = `(kicad_sch (version 20231120) (generator eeschema) (uuid 00000000-0000-0000-0000-000000000000) (lib_symbols))\n`;

describe('create stage contracts', () => {
  it('does not treat a configured blank schematic as complete', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      await writeFile(path.join(repo, 'hardware', 'open-key.kicad_sch'), blankSchematic, 'utf8');

      await expect(stage('schematic').isComplete(repo, 'docs/')).resolves.toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('treats a malformed schematic as an unmet contract instead of throwing', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      await writeFile(path.join(repo, 'hardware', 'open-key.kicad_sch'), 'not a KiCad schematic', 'utf8');

      await expect(stage('schematic').isComplete(repo, 'docs/')).resolves.toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('does not treat init\'s empty layout template as complete', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });

      await expect(stage('layout-draft').isComplete(repo, 'docs/')).resolves.toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('requires a real footprint expression rather than footprint-like board text', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      await writeFile(path.join(repo, 'hardware', 'open-key.kicad_pcb'), `(kicad_pcb (gr_text "(footprint fake)"))\n`, 'utf8');
      await writeFile(path.join(repo, 'docs', 'LAYOUT.md'), '# Layout intent\n\n## Draft quality\n\nHuman-reviewed draft.\n', 'utf8');

      await expect(stage('layout-draft').isComplete(repo, 'docs/')).resolves.toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('halts when an agent reports success without satisfying the active stage contract', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      await writeFile(path.join(repo, 'hardware', 'open-key.kicad_sch'), blankSchematic, 'utf8');
      const brief = path.join(repo, 'brief.md');
      await writeFile(brief, '# Brief\n', 'utf8');
      mocks.runAgentLoop.mockResolvedValue({ outcome: 'success' });
      mocks.openspecInit.mockResolvedValue(undefined);
      mocks.runCheck.mockResolvedValue({ ok: true });
      const log = vi.fn();

      const result = await runCreate({ repoRoot: repo, briefPath: brief, model: 'gpt-5', log });

      expect(result).toEqual({ ok: false, completed: ['spec-seed', 'architecture', 'part-selection'] });
      expect(mocks.runAgentLoop).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('stage contract is not met'));
    } finally {
      await cleanup();
    }
  });
});
