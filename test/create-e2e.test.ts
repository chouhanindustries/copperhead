import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { STAGES } from '../src/commands/create.js';
import { tempFixtureRepo } from './helpers.js';

describe('create pipeline: e2e stage contracts (bounty AC)', () => {
  it('stage names and order are correct', () => {
    expect(STAGES.map((s) => s.name)).toEqual([
      'spec-seed', 'architecture', 'part-selection', 'schematic',
      'layout-draft', 'outputs', 'firmware', 'devplan',
    ]);
  });

  it('spec-seed isComplete detects SPEC.md with Budgets heading', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const docs = path.join(repo, 'docs');
      await mkdir(docs, { recursive: true });
      const stage = STAGES[0];
      expect(stage.name).toBe('spec-seed');
      // No file: not complete
      expect(await stage.isComplete(repo, 'docs')).toBe(false);
      // File exists but missing Budgets: not complete
      await writeFile(path.join(docs, 'SPEC.md'), '# Device\n', 'utf8');
      expect(await stage.isComplete(repo, 'docs')).toBe(false);
      // Valid file: complete
      await writeFile(path.join(docs, 'SPEC.md'), '# Device\n\n## Budgets and constraints\n', 'utf8');
      expect(await stage.isComplete(repo, 'docs')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('architecture isComplete detects SUBSYSTEMS.md', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const docs = path.join(repo, 'docs');
      await mkdir(docs, { recursive: true });
      const stage = STAGES[1];
      expect(stage.name).toBe('architecture');
      expect(await stage.isComplete(repo, 'docs')).toBe(false);
      await writeFile(path.join(docs, 'SUBSYSTEMS.md'), '# Architecture\n', 'utf8');
      expect(await stage.isComplete(repo, 'docs')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('part-selection isComplete detects BOM.md', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const docs = path.join(repo, 'docs');
      await mkdir(docs, { recursive: true });
      const stage = STAGES[2];
      expect(stage.name).toBe('part-selection');
      expect(await stage.isComplete(repo, 'docs')).toBe(false);
      await writeFile(path.join(docs, 'BOM.md'), '# BOM\n', 'utf8');
      expect(await stage.isComplete(repo, 'docs')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('layout-draft isComplete detects LAYOUT.md with Draft quality heading + board with footprint', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const docs = path.join(repo, 'docs');
      await mkdir(docs, { recursive: true });
      const stage = STAGES[4];
      expect(stage.name).toBe('layout-draft');
      // No LAYOUT.md, no board config -> not complete
      expect(await stage.isComplete(repo, 'docs')).toBe(false);
      // LAYOUT.md exists with heading but no board config
      await writeFile(path.join(docs, 'LAYOUT.md'), '# Layout\n\n## Draft quality\n', 'utf8');
      expect(await stage.isComplete(repo, 'docs')).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('outputs isComplete detects outputs/ directory', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const stage = STAGES[5];
      expect(stage.name).toBe('outputs');
      expect(await stage.isComplete(repo, 'docs')).toBe(false);
      await mkdir(path.join(repo, 'outputs'), { recursive: true });
      expect(await stage.isComplete(repo, 'docs')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('firmware isComplete detects firmware/ directory', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const stage = STAGES[6];
      expect(stage.name).toBe('firmware');
      expect(await stage.isComplete(repo, 'docs')).toBe(false);
      await mkdir(path.join(repo, 'firmware'), { recursive: true });
      expect(await stage.isComplete(repo, 'docs')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('devplan isComplete detects DEVPLAN.md', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const docs = path.join(repo, 'docs');
      await mkdir(docs, { recursive: true });
      const stage = STAGES[7];
      expect(stage.name).toBe('devplan');
      expect(await stage.isComplete(repo, 'docs')).toBe(false);
      await writeFile(path.join(docs, 'DEVPLAN.md'), '# Dev plan\n', 'utf8');
      expect(await stage.isComplete(repo, 'docs')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('all 8 stages have prompt and isComplete functions (contract integrity)', () => {
    // Verify pipeline structure: all stages export prompt generators and
    // completion detectors. The actual resume-command logic is tested in
    // create-resilience.test.ts (commitResumedStage, resume command format).
    expect(STAGES.length).toBe(8);
    expect(STAGES[0].prompt).toBeInstanceOf(Function);
    expect(STAGES[0].isComplete).toBeInstanceOf(Function);
    for (const s of STAGES) {
      expect(s.prompt).toBeInstanceOf(Function);
      expect(s.isComplete).toBeInstanceOf(Function);
    }
  });
});
