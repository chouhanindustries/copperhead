import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { runAgentLoop } from '../src/agent/loop.js';
import { dirtyFiles, gitPreflight, isDirty } from '../src/util/git.js';
import { PreflightError, isNotFoundError } from '../src/util/preflight.js';
import { KicadCliMissingError } from '../src/kicad/cli.js';
import { tempFixtureRepo } from './helpers.js';

// The git preflight throws before the provider is constructed and before
// transcript.init(), so these run the real loop offline: no API key is read,
// no network is touched, no run dir is written.

const loopOpts = (repoRoot: string) => ({
  repoRoot,
  model: 'gpt-5',
  request: 'test request',
  log: () => {},
});

async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ch-preflight-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe('git preflight (unborn HEAD, AC-3.8)', () => {
  it('non-git directory: friendly error, not raw git output', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await expect(runAgentLoop(loopOpts(dir))).rejects.toThrow(
        /not a git repository; copperhead requires git/,
      );
    } finally {
      await cleanup();
    }
  });

  it('unborn HEAD: friendly error with the fix spelled out, no exit-128 noise', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await execa('git', ['init', '-q'], { cwd: dir });
      const err = await runAgentLoop(loopOpts(dir)).then(
        () => null,
        (e: Error) => e,
      );
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/repository has no commits/);
      expect(err!.message).toMatch(/git add -A && git commit/);
      expect(err!.message).not.toMatch(/exit code 128|ambiguous argument/);
    } finally {
      await cleanup();
    }
  });

  it('staged-but-uncommitted files still count as no commits', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await execa('git', ['init', '-q'], { cwd: dir });
      await writeFile(path.join(dir, 'brief.md'), 'a brief', 'utf8');
      await execa('git', ['add', '-A'], { cwd: dir });
      await expect(runAgentLoop(loopOpts(dir))).rejects.toThrow(/repository has no commits/);
    } finally {
      await cleanup();
    }
  });

  it('detection is independent of the default branch name', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await execa('git', ['init', '-q', '-b', 'main'], { cwd: dir });
      await expect(runAgentLoop(loopOpts(dir))).rejects.toThrow(/repository has no commits/);
    } finally {
      await cleanup();
    }
  });

  it('a failed preflight leaves no .copperhead footprint', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await execa('git', ['init', '-q'], { cwd: dir });
      await runAgentLoop(loopOpts(dir)).catch(() => {});
      expect(existsSync(path.join(dir, '.copperhead'))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('checks run in order repo -> commits -> dirty: a committed repo passes the commit gate', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await writeFile(path.join(repo, 'junk.txt'), 'dirty', 'utf8');
      // reaching the dirty-tree error proves both git gates before it passed
      await expect(runAgentLoop(loopOpts(repo))).rejects.toThrow(/working tree is dirty/);
    } finally {
      await cleanup();
    }
  });
});

// `create` no longer refuses over these two states — it sets git up itself, so
// a new user's first command works in a directory they just made. The
// behaviour that replaced the refusals is covered in create-setup.test.ts;
// what stays asserted here is that the strict gates still apply to `do`.

describe('preflight failures explain why and how to fix', () => {
  async function preflightError(dir: string, allowDirty = false): Promise<PreflightError> {
    const err = await gitPreflight(dir, { allowDirty }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PreflightError);
    return err as PreflightError;
  }

  it('non-git directory: why line plus numbered remedy steps ending in a rerun', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const err = await preflightError(dir);
      expect(err.message).toMatch(/why it failed: .*snapshot/);
      expect(err.message).toMatch(/to fix:\n  1\. git init\n  2\. git add -A && git commit/);
      expect(err.message).toMatch(/rerun the same copperhead command/);
    } finally {
      await cleanup();
    }
  });

  it('unborn HEAD: explains there is nothing to roll back to, remedy is the first commit', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await execa('git', ['init', '-q'], { cwd: dir });
      const err = await preflightError(dir);
      expect(err.message).toMatch(/why it failed: .*nothing to roll back to/);
      expect(err.message).toMatch(/1\. git add -A && git commit/);
    } finally {
      await cleanup();
    }
  });

  it('dirty tree: explains rollback would destroy uncommitted work, offers commit/stash/--allow-dirty', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await writeFile(path.join(repo, 'junk.txt'), 'dirty', 'utf8');
      const err = await preflightError(repo);
      expect(err.message).toMatch(/why it failed: .*destroy your uncommitted work/);
      expect(err.message).toMatch(/git add -A && git commit/);
      expect(err.message).toMatch(/git stash/);
      expect(err.message).toMatch(/--allow-dirty/);
      // the offered flag actually works
      await expect(gitPreflight(repo, { allowDirty: true })).resolves.toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('copperhead\'s own run artifacts never trip the gate, even unignored', async () => {
    // Regression: in a repo the user set up by hand (git init && git commit, no
    // copperhead .gitignore), the REPL opens its session log under
    // .copperhead/runs/ before the first turn. git status then reports
    // "?? .copperhead/" and the gate refused the run over a file copperhead had
    // just written — telling the user to commit or stash work that was not
    // theirs. The audit trail survives rollback by design, so it is not the
    // user's uncommitted work and must not count as dirty.
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await rm(path.join(repo, '.gitignore'), { force: true });
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-q', '--allow-empty', '-m', 'no copperhead ignores'], { cwd: repo });

      await mkdir(path.join(repo, '.copperhead', 'runs'), { recursive: true });
      await writeFile(path.join(repo, '.copperhead', 'runs', 'repl-2026-01-01.log'), 'session', 'utf8');
      expect((await execa('git', ['status', '--porcelain'], { cwd: repo })).stdout).toContain('.copperhead/');

      await expect(gitPreflight(repo)).resolves.toBeUndefined();
      expect(await dirtyFiles(repo)).toEqual([]);
      expect(await isDirty(repo)).toBe(false);

      // The user's own uncommitted work still stops the run.
      await writeFile(path.join(repo, 'junk.txt'), 'dirty', 'utf8');
      expect(await dirtyFiles(repo)).toEqual(['junk.txt']);
      await expect(gitPreflight(repo)).rejects.toThrow(/working tree is dirty/);
    } finally {
      await cleanup();
    }
  });

  it('exposes reason/why/remedy as structured fields for programmatic callers', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const err = await preflightError(dir);
      expect(err.reason).toMatch(/not a git repository/);
      expect(err.why).toBeTruthy();
      expect(err.remedy.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  it('missing kicad-cli is a PreflightError with install steps', () => {
    const err = new KicadCliMissingError();
    expect(err).toBeInstanceOf(PreflightError);
    expect(err.message).toMatch(/why it failed: .*ERC\/DRC/);
    expect(err.message).toMatch(/1\. install KiCad/);
    expect(err.message).toMatch(/kicad-cli version/);
  });

  it('the loop surfaces the full explanation, not just the reason line', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await execa('git', ['init', '-q'], { cwd: dir });
      const err = await runAgentLoop(loopOpts(dir)).then(
        () => null,
        (e: Error) => e,
      );
      expect(err!.message).toMatch(/why it failed:/);
      expect(err!.message).toMatch(/to fix:/);
    } finally {
      await cleanup();
    }
  });
});

describe('isNotFoundError helper', () => {
  const originalPlatform = process.platform;

  it('identifies ENOENT as not found on any platform', () => {
    expect(isNotFoundError({ code: 'ENOENT' })).toBe(true);
    expect(isNotFoundError({ code: 'EACCES' })).toBe(false);
    expect(isNotFoundError(null)).toBe(false);
  });

  it('identifies Windows command missing errors under win32 platform override', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(isNotFoundError({
        exitCode: 9009,
        stderr: "'kicad-cli' is not recognized as an internal or external command"
      })).toBe(true);



      expect(isNotFoundError({
        exitCode: 1,
        stderr: "'openspec' is not recognized as an internal or external command, operable program or batch file."
      })).toBe(true);

      // Negative cases
      expect(isNotFoundError({
        exitCode: 1,
        stderr: "ERC violations found"
      })).toBe(false);

      expect(isNotFoundError({
        exitCode: 2,
        stderr: "some random error"
      })).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('classifies a real execa spawn failure as not-found', async () => {
    const err = await execa('copperhead-does-not-exist', []).catch((e) => e);
    expect(isNotFoundError(err)).toBe(true);
  });

  it('classifies a non-rejecting execa failure result as not-found', async () => {
    const res = await execa('copperhead-does-not-exist', [], { reject: false });
    expect(isNotFoundError(res)).toBe(true);
  });
});
