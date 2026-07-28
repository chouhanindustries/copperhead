import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { STAGES } from '../src/commands/create.js';

/**
 * Stage-completion contracts must be heading-aware, not literal substring
 * matches (PIPELINE-ISSUES.md Issue 1): the model writes valid docs with
 * numbered/decorated headings ("## 3. Budgets and constraints"), and a literal
 * '## Budgets' / '## Draft quality' match rejects them forever, wedging the
 * pipeline in a commit-but-never-advance loop. These tests drive the real
 * STAGES contracts against on-disk docs, no LLM involved.
 */

function stage(name: string) {
  const s = STAGES.find((x) => x.name === name);
  if (!s) throw new Error(`no such stage: ${name}`);
  return s;
}

/** Bare temp repo; stage contracts read files, they never need git. */
async function tempRepo(): Promise<{ repo: string; cleanup: () => Promise<void> }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-stage-'));
  await mkdir(path.join(repo, 'docs'), { recursive: true });
  return { repo, cleanup: () => rm(repo, { recursive: true, force: true }) };
}

describe('spec-seed completion contract (heading-aware, Issue 1)', () => {
  it('accepts a numbered, decorated Budgets heading', async () => {
    const { repo, cleanup } = await tempRepo();
    try {
      await writeFile(
        path.join(repo, 'docs', 'SPEC.md'),
        '# Device\n\n## 3. Budgets and constraints (ASSUMED where unstated)\n\n- power: 10 mA\n',
        'utf8',
      );
      expect(await stage('spec-seed').isComplete(repo, 'docs')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('rejects a SPEC.md with no budget heading at all', async () => {
    const { repo, cleanup } = await tempRepo();
    try {
      await writeFile(path.join(repo, 'docs', 'SPEC.md'), '# Device\n\nThe budgets are generous.\n', 'utf8');
      expect(await stage('spec-seed').isComplete(repo, 'docs')).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

describe('layout-draft completion contract (heading-aware, Issue 1)', () => {
  /** Board + config prerequisites so the contract reaches the LAYOUT.md check. */
  async function seedBoard(repo: string): Promise<void> {
    await mkdir(path.join(repo, '.copperhead'), { recursive: true });
    await mkdir(path.join(repo, 'hardware'), { recursive: true });
    await writeFile(
      path.join(repo, '.copperhead', 'config.json'),
      JSON.stringify({ board: 'hardware/board.kicad_pcb' }) + '\n',
      'utf8',
    );
    await writeFile(
      path.join(repo, 'hardware', 'board.kicad_pcb'),
      '(kicad_pcb (version 20240108) (footprint "Resistor_SMD:R_0402_1005Metric"))\n',
      'utf8',
    );
  }

  it('accepts a numbered Draft quality heading', async () => {
    const { repo, cleanup } = await tempRepo();
    try {
      await seedBoard(repo);
      await writeFile(
        path.join(repo, 'docs', 'LAYOUT.md'),
        '# Layout\n\n## 5. Draft quality notes\n\n- power routed; rest is ratsnest\n',
        'utf8',
      );
      expect(await stage('layout-draft').isComplete(repo, 'docs')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('still accepts the literal "## Draft quality" heading (regression)', async () => {
    const { repo, cleanup } = await tempRepo();
    try {
      await seedBoard(repo);
      await writeFile(path.join(repo, 'docs', 'LAYOUT.md'), '# Layout\n\n## Draft quality\n\n- fine\n', 'utf8');
      expect(await stage('layout-draft').isComplete(repo, 'docs')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('rejects a LAYOUT.md whose only "Draft quality" mention is body text, not a heading', async () => {
    const { repo, cleanup } = await tempRepo();
    try {
      await seedBoard(repo);
      await writeFile(
        path.join(repo, 'docs', 'LAYOUT.md'),
        '# Layout\n\nDraft quality was not assessed.\n',
        'utf8',
      );
      expect(await stage('layout-draft').isComplete(repo, 'docs')).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('rejects the heading alone when the board has no footprints (init scaffold)', async () => {
    const { repo, cleanup } = await tempRepo();
    try {
      await seedBoard(repo);
      await writeFile(path.join(repo, 'hardware', 'board.kicad_pcb'), '(kicad_pcb (version 20240108))\n', 'utf8');
      await writeFile(path.join(repo, 'docs', 'LAYOUT.md'), '# Layout\n\n## Draft quality\n\n- fine\n', 'utf8');
      expect(await stage('layout-draft').isComplete(repo, 'docs')).toBe(false);
    } finally {
      await cleanup();
    }
  });
});
