import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectRunMeta, renderCliHeader, renderEnvironmentSection, type RunMeta } from '../src/agent/runmeta.js';
import { loadConfig } from '../src/config.js';
import { tempFixtureRepo } from './helpers.js';

const baseInput = {
  command: 'do' as const,
  modelSource: 'flag' as const,
  version: '1.2.3',
  kicadCliVersion: '9.0.0',
};

async function collect(repo: string, extra: Partial<Parameters<typeof collectRunMeta>[0]> = {}): Promise<RunMeta> {
  return collectRunMeta({
    repoRoot: repo,
    config: await loadConfig(repo),
    maxTurns: 12,
    runId: 'run-1',
    request: 'test request',
    model: 'gpt-5',
    provider: 'openai',
    interactive: false,
    input: baseInput,
    ...extra,
  });
}

describe('collectRunMeta (task 2.5)', () => {
  it('reflects the resolved run, not just the config file (AC-8.2)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const meta = await collect(repo);
      expect(meta.config.maxTurns).toBe(12); // effective override, not the default 40
      expect(meta.modelSource).toBe('flag');
      // unconfigured schematic is a present null key, not an omitted one
      expect('schematic' in meta.config).toBe(true);
      expect(meta.config.schematic).toBeNull();
      expect(meta.versions.copperhead).toBe('1.2.3');
      expect(meta.versions.kicadCli).toBe('9.0.0');
      expect(meta.versions.node).toBe(process.version);
      expect(meta.git.commit).toBeTruthy();
      expect(meta.git.dirty).toBe(false);
      expect(meta.git.uncommittedFiles).toBe(0);
      expect(meta.git.preCommitHookInstalled).toBe(false);
      expect(meta.openConstraints).toBe(0);
      expect(meta.priorRuns).toBe(0);
      expect(meta.command).toBe('do');
    } finally {
      await cleanup();
    }
  });

  it('degrades failed probes to null instead of failing (AC-8.3)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-nongit-'));
    try {
      const meta = await collect(dir);
      expect(meta.git.commit).toBeNull();
      expect(meta.git.branch).toBeNull();
      expect(meta.git.dirty).toBeNull();
      expect(meta.git.uncommittedFiles).toBeNull();
      // everything non-git still populates
      expect(meta.versions.node).toBe(process.version);
      expect(meta.config.maxTurns).toBe(12);
      expect(meta.runId).toBe('run-1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('metadata renderers (task 2.5)', () => {
  it('CLI header is at most two lines and names model, source, stage, and budget (AC-8.4)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const meta = await collect(repo, {
        input: { ...baseInput, command: 'create', stage: { name: 'schematic', index: 4, total: 8 } },
      });
      const header = renderCliHeader(meta);
      expect(header.length).toBeLessThanOrEqual(2);
      const text = header.join('\n');
      expect(text).toContain('copperhead v1.2.3');
      expect(text).toContain('kicad-cli 9.0.0');
      expect(text).toContain('model gpt-5 (openai, via flag)');
      expect(text).toContain('stage schematic (4/8)');
      expect(text).toContain('turns ≤12');
    } finally {
      await cleanup();
    }
  });

  it('environment section mirrors the collected values (AC-8.4)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const meta = await collect(repo);
      const section = renderEnvironmentSection(meta).join('\n');
      expect(section).toContain('## Environment');
      expect(section).toContain('schematic null');
      expect(section).toContain('via flag');
      expect(section).toContain('maxTurns 12');
      expect(section).toContain('pre-commit hook absent');
    } finally {
      await cleanup();
    }
  });
});
