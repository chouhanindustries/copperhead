import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveInRepo, SandboxError, isKicadFile } from '../src/util/paths.js';
import { redactSecrets } from '../src/util/redact.js';
import { withRetry } from '../src/util/retry.js';
import { toolWriteFile, toolEditFile, toolSearch } from '../src/agent/filetools.js';
import { Transcript } from '../src/agent/transcript.js';
import { isDirty, hasCommits, snapshot, restore, recoveryCommand } from '../src/util/git.js';
import { tempFixtureRepo } from './helpers.js';
import { execa } from 'execa';

describe('path sandbox (AC-4.2)', () => {
  it('rejects traversal outside the repo root', () => {
    expect(() => resolveInRepo('/repo', '../../etc/hosts')).toThrow(SandboxError);
    expect(() => resolveInRepo('/repo', '/etc/hosts')).toThrow(SandboxError);
  });

  it('accepts repo-relative paths including the root itself', () => {
    expect(resolveInRepo('/repo', 'docs/BOM.md')).toBe('/repo/docs/BOM.md');
    expect(resolveInRepo('/repo', '.')).toBe('/repo');
  });

  it('does not treat sibling dirs with a shared prefix as inside', () => {
    expect(() => resolveInRepo('/repo', '../repo-evil/x')).toThrow(SandboxError);
  });
});

describe('secret redaction (AC-4.1)', () => {
  it('redacts sk- keys and bearer tokens', () => {
    const input = 'key=sk-abc123DEF456ghi789jkl012 Authorization: Bearer abcdefghijklmnop123456';
    const out = redactSecrets(input);
    expect(out).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
    expect(out).toContain('[REDACTED]');
  });

  it('redacts registry and forge tokens, not just model keys', () => {
    // Synthetic tokens: correct shape, never valid.
    const input = [
      'npm_0000000000000000000000000000000000AA',
      'ghp_0000000000000000000000000000000000BB',
      'github_pat_0000000000000000000000_CCCC',
    ].join(' ');
    const out = redactSecrets(input);
    expect(out).not.toMatch(/npm_[A-Za-z0-9]{36,}/);
    expect(out).not.toMatch(/gh[pousr]_[A-Za-z0-9]{36,}/);
    expect(out).not.toMatch(/github_pat_/);
    expect(out).toBe('[REDACTED] [REDACTED] [REDACTED]');
  });

  it('transcript and summary are redacted at write time', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ch-'));
    const t = new Transcript(dir);
    await t.init();
    await t.event('test', { secret: 'sk-abc123DEF456ghi789jkl012' });
    const summaryPath = await t.writeSummary({
      request: 'uses sk-abc123DEF456ghi789jkl012',
      changeId: null,
      plan: null,
      filesTouched: [],
      ercResult: null,
      drcResult: null,
      decisions: [],
      tokensIn: 0,
      tokensOut: 0,
      outcome: 'success',
      openObligations: null,
    });
    const jsonl = await readFile(t.jsonlPath, 'utf8');
    const summary = await readFile(summaryPath, 'utf8');
    expect(jsonl).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
    expect(summary).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
  });

  it('recreates its audit directory when rollback removed it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ch-'));
    const t = new Transcript(dir);
    await t.init();
    await rm(t.dir, { recursive: true, force: true });

    await t.event('run-failed', { reason: 'repair budget exhausted' });
    const summaryPath = await t.writeSummary({
      request: 'test rollback recovery',
      changeId: null,
      plan: null,
      filesTouched: [],
      ercResult: null,
      drcResult: null,
      decisions: [],
      tokensIn: 0,
      tokensOut: 0,
      outcome: 'failure',
      openObligations: null,
    });

    expect(await readFile(t.jsonlPath, 'utf8')).toContain('run-failed');
    expect(await readFile(summaryPath, 'utf8')).toContain('# Run summary');
  });
});

describe('file tools', () => {
  it('write_file refuses KiCad files and overwrites', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ch-'));
    await expect(toolWriteFile(dir, 'x.kicad_sch', 'nope')).rejects.toThrow(/refuses KiCad/);
    await toolWriteFile(dir, 'a.md', 'hello');
    await expect(toolWriteFile(dir, 'a.md', 'again')).rejects.toThrow(/overwrite/);
  });

  it('edit_file requires a unique anchor with actionable errors', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ch-'));
    await writeFile(path.join(dir, 'f.txt'), 'aaa\nbbb\naaa\n');
    await expect(toolEditFile(dir, 'f.txt', 'zzz', 'x')).rejects.toThrow(/not found/);
    await expect(toolEditFile(dir, 'f.txt', 'aaa', 'x')).rejects.toThrow(/matched 2 times/);
    await toolEditFile(dir, 'f.txt', 'bbb', 'ccc');
    expect(await readFile(path.join(dir, 'f.txt'), 'utf8')).toBe('aaa\nccc\naaa\n');
  });

  it('search finds regex matches with glob filtering', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ch-'));
    await writeFile(path.join(dir, 'a.md'), 'KEY_DAH here');
    await writeFile(path.join(dir, 'b.txt'), 'KEY_DAH there');
    const all = await toolSearch(dir, 'KEY_DAH');
    expect(all).toHaveLength(2);
    const mdOnly = await toolSearch(dir, 'KEY_DAH', '**/*.md');
    expect(mdOnly).toHaveLength(1);
    expect(mdOnly[0]!.file).toBe('a.md');
  });

  it('isKicadFile covers the design formats', () => {
    expect(isKicadFile('a/b.kicad_sch')).toBe(true);
    expect(isKicadFile('a/b.kicad_pcb')).toBe(true);
    expect(isKicadFile('a/b.md')).toBe(false);
  });
});

describe('retry', () => {
  it('backs off on 429 then succeeds', async () => {
    let calls = 0;
    const res = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error('rate'), { status: 429 });
        return 'ok';
      },
      { sleep: async () => {} },
    );
    expect(res).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry non-429 errors', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error('boom');
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });
});

describe('git guard (AC-3.8, AC-3.6)', () => {
  it('shell-quotes every snapshot ref in manual recovery commands', () => {
    expect(recoveryCommand({ head: "head'with-quote", stash: "stash'with-quote" })).toBe(
      `git reset --hard 'head'"'"'with-quote' && git clean -fd -e .copperhead/runs && git stash apply 'stash'"'"'with-quote'`,
    );
  });

  it('hasCommits distinguishes an unborn HEAD from a committed repo', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ch-'));
    expect(await hasCommits(dir)).toBe(false); // not a repo at all
    await execa('git', ['init', '-q'], { cwd: dir });
    expect(await hasCommits(dir)).toBe(false); // repo, but no commits yet
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      expect(await hasCommits(repo)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('snapshot and restore leave the tree byte-identical', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      expect(await isDirty(repo)).toBe(false);
      const snap = await snapshot(repo);
      const sch = path.join(repo, 'hardware', 'open-key.kicad_sch');
      const before = await readFile(sch, 'utf8');
      await writeFile(sch, before.replace('KEY_DAH', 'KEY_RUINED'), 'utf8');
      await writeFile(path.join(repo, 'junk.txt'), 'junk', 'utf8');
      expect(await isDirty(repo)).toBe(true);
      await restore(repo, snap);
      expect(await isDirty(repo)).toBe(false);
      expect(await readFile(sch, 'utf8')).toBe(before);
    } finally {
      await cleanup();
    }
  });

  it('preserves a staged in-flight audit trail during rollback', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const snap = await snapshot(repo);
      const runFile = path.join(repo, '.copperhead', 'runs', 'in-flight', 'transcript.jsonl');
      await mkdir(path.dirname(runFile), { recursive: true });
      await writeFile(runFile, '{"type":"run-start"}\n', 'utf8');
      await execa('git', ['add', '-f', '.copperhead/runs/in-flight/transcript.jsonl'], { cwd: repo });

      await restore(repo, snap);

      expect(await readFile(runFile, 'utf8')).toBe('{"type":"run-start"}\n');
    } finally {
      await cleanup();
    }
  });

  it('preserves the audit trail even when rollback fails', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const snap = await snapshot(repo);
      const runFile = path.join(repo, '.copperhead', 'runs', 'in-flight', 'transcript.jsonl');
      await mkdir(path.dirname(runFile), { recursive: true });
      await writeFile(runFile, '{"type":"run-start"}\n', 'utf8');
      await execa('git', ['add', '-f', '.copperhead/runs/in-flight/transcript.jsonl'], { cwd: repo });

      await expect(restore(repo, { ...snap, stash: 'not-a-stash' })).rejects.toThrow();

      expect(await readFile(runFile, 'utf8')).toBe('{"type":"run-start"}\n');
    } finally {
      await cleanup();
    }
  });

  it('still rolls back when temporary audit backup storage is unavailable', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    const originalTmpDir = process.env.TMPDIR;
    try {
      const snap = await snapshot(repo);
      const sch = path.join(repo, 'hardware', 'open-key.kicad_sch');
      const before = await readFile(sch, 'utf8');
      await writeFile(sch, before.replace('KEY_DAH', 'KEY_RUINED'), 'utf8');
      process.env.TMPDIR = path.join(repo, 'missing-temp-directory');

      await expect(restore(repo, snap)).resolves.toBeUndefined();

      expect(await readFile(sch, 'utf8')).toBe(before);
    } finally {
      process.env.TMPDIR = originalTmpDir;
      await cleanup();
    }
  });
});
