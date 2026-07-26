import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveInRepo, SandboxError, isKicadFile } from '../src/util/paths.js';
import { redactSecrets } from '../src/util/redact.js';
import { withRetry } from '../src/util/retry.js';
import { toolWriteFile, toolEditFile, toolSearch } from '../src/agent/filetools.js';
import { Transcript } from '../src/agent/transcript.js';
import { isDirty, hasCommits, snapshot, restore } from '../src/util/git.js';
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

  it('search does not read through a symlink that leaves the repo', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'ch-search-esc-'));
    const repo = path.join(base, 'repo');
    const outside = path.join(base, 'outside');
    await mkdir(path.join(repo, 'sub'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(repo, 'b.txt'), 'needle two\n', 'utf8');
    await writeFile(path.join(repo, 'sub', 'a.txt'), 'needle here\n', 'utf8');
    await writeFile(path.join(outside, 'leak.txt'), 'needle SECRET outside\n', 'utf8');
    await symlink(outside, path.join(repo, 'link'));

    const matches = await toolSearch(repo, 'needle');

    // The escaping match used to come back as "link/leak.txt", which reads as a
    // repo-relative path and hides that the content was outside the sandbox.
    expect(matches.map((m) => m.file).sort()).toEqual(['b.txt', path.join('sub', 'a.txt')]);
    expect(matches.some((m) => m.text.includes('SECRET'))).toBe(false);
  });

  it('search survives a symlink loop instead of dying with ELOOP', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'ch-search-loop-'));
    const repo = path.join(base, 'repo');
    await mkdir(path.join(repo, 'sub'), { recursive: true });
    await writeFile(path.join(repo, 'sub', 'a.txt'), 'needle here\n', 'utf8');
    await symlink(repo, path.join(repo, 'sub', 'loop'));

    // Previously this walked loop/sub/loop/sub/... until the OS threw, taking
    // the search tool down for the rest of the run.
    const matches = await toolSearch(repo, 'needle');

    expect(matches).toHaveLength(1);
    expect(matches[0]!.file).toBe(path.join('sub', 'a.txt'));
  });

  it('search does not report a file twice through a link back to the repo root', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'ch-search-dup-'));
    const repo = path.join(base, 'repo');
    await mkdir(path.join(repo, 'sub'), { recursive: true });
    // A match at the ROOT is what exposes this: the loop test above only has a
    // file under sub/, so re-walking the root produced nothing to duplicate.
    await writeFile(path.join(repo, 'a.txt'), 'needle A\n', 'utf8');
    await writeFile(path.join(repo, 'sub', 'b.txt'), 'needle B\n', 'utf8');
    await symlink(repo, path.join(repo, 'sub', 'back'));

    const matches = await toolSearch(repo, 'needle');

    // Without seeding seenDirs with the root, this returns a third match at
    // sub/back/a.txt — the same file reported under the link's path.
    expect(matches.map((m) => m.file).sort()).toEqual(['a.txt', path.join('sub', 'b.txt')]);
  });

  it('search still follows a symlink that stays inside the repo', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'ch-search-in-'));
    const repo = path.join(base, 'repo');
    await mkdir(path.join(repo, 'real'), { recursive: true });
    await writeFile(path.join(repo, 'real', 'lib.txt'), 'needle inside\n', 'utf8');
    // A symlinked *file*, not a directory: a directory alias is subject to
    // readdir ordering, so only a file link pins "the link was followed"
    // deterministically.
    await symlink(path.join(repo, 'real', 'lib.txt'), path.join(repo, 'alias.txt'));

    const matches = await toolSearch(repo, 'needle');

    // Symlinked library paths are a normal KiCad layout: the file is reachable
    // by both names, and neither traversal is an escape. Asserting the exact
    // set is what makes this a guard rail — refusing to follow the link drops
    // alias.txt and fails here.
    expect(matches.map((m) => m.file).sort()).toEqual(['alias.txt', path.join('real', 'lib.txt')]);
  });

  it('search reports a directory reachable by both its real name and an alias', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'ch-search-alias-'));
    const repo = path.join(base, 'repo');
    await mkdir(path.join(repo, 'zreal'), { recursive: true });
    await writeFile(path.join(repo, 'zreal', 'lib.txt'), 'needle inside\n', 'utf8');
    // Sorts before 'zreal', so readdir yields the alias first: with walk-global
    // loop detection the real directory is pruned and a path-anchored glob
    // finds nothing.
    await symlink(path.join(repo, 'zreal'), path.join(repo, 'aalias'));

    expect((await toolSearch(repo, 'needle')).map((m) => m.file).sort()).toEqual([
      path.join('aalias', 'lib.txt'),
      path.join('zreal', 'lib.txt'),
    ]);
    expect((await toolSearch(repo, 'needle', 'zreal/**')).map((m) => m.file)).toEqual([
      path.join('zreal', 'lib.txt'),
    ]);
  });

  it('search steps over a dangling symlink instead of failing the walk', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'ch-search-dangle-'));
    await writeFile(path.join(repo, 'a.txt'), 'needle A\n', 'utf8');
    await symlink(path.join(repo, 'gone'), path.join(repo, 'dangle'));

    // A broken link is an ordinary thing to find in a checkout. The arm that
    // actually saves the walk is realpath's in insideRoot: it fails first and
    // drops the entry, so stat is never reached with a dangling target.
    expect((await toolSearch(repo, 'needle')).map((m) => m.file)).toEqual(['a.txt']);
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
