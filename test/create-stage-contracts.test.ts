import { describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runInit } from '../src/memory/scaffold.js';
import { STAGES } from '../src/commands/create.js';
import { tempFixtureRepo } from './helpers.js';

const stage = (name: string) => {
  const found = STAGES.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`stage ${name} not found`);
  return found;
};

describe('create stage completion contracts', () => {
  it('does not treat init placeholders as a completed spec or layout stage', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });

      await expect(stage('spec-seed').isComplete(repo, 'docs/')).resolves.toBe(false);
      await expect(stage('layout-draft').isComplete(repo, 'docs/')).resolves.toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('recognizes filled spec and layout contracts with a real footprint', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      await writeFile(path.join(repo, 'docs', 'SPEC.md'), '# Spec\n\n## Budgets\n\n- sleep_current_uA: 25\n', 'utf8');
      await writeFile(path.join(repo, 'docs', 'LAYOUT.md'), '# Layout\n\n## Draft quality\n\nHuman-reviewed draft.\n', 'utf8');
      await writeFile(path.join(repo, 'hardware', 'open-key.kicad_pcb'), '(kicad_pcb (footprint "Test" (layer "F.Cu") (at 0 0)))\n', 'utf8');

      await expect(stage('spec-seed').isComplete(repo, 'docs/')).resolves.toBe(true);
      await expect(stage('layout-draft').isComplete(repo, 'docs/')).resolves.toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('treats malformed schematic and board files as incomplete rather than throwing', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      await writeFile(path.join(repo, 'hardware', 'open-key.kicad_sch'), 'not a schematic', 'utf8');
      await writeFile(path.join(repo, 'hardware', 'open-key.kicad_pcb'), 'not a board', 'utf8');

      await expect(stage('schematic').isComplete(repo, 'docs/')).resolves.toBe(false);
      await expect(stage('layout-draft').isComplete(repo, 'docs/')).resolves.toBe(false);
    } finally {
      await cleanup();
    }
  });
});
