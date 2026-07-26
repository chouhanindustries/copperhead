import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { tempFixtureRepo } from './helpers.js';

/**
 * Command-level coverage for the one line the unit tests cannot reach: the CLI
 * turning `InitResult.hookSkipped` into something the user actually sees. The
 * bug this guards against was a real outcome that never reached stdout, so
 * asserting the reporting contract, not just the returned value, is the point.
 *
 * `init` gates on `kicad-cli version` before doing anything. The stub below
 * satisfies exactly that preflight; every other path these tests touch (doc
 * scaffolding, hook installation, output rendering) is the real code, and
 * nothing here runs ERC or DRC.
 */
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

let stubDir: string;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  stubDir = await mkdtemp(path.join(tmpdir(), 'copperhead-kicad-stub-'));
  const stub = path.join(stubDir, 'kicad-cli');
  await writeFile(stub, '#!/bin/sh\necho "kicad-cli version 10.0.4 (test stub)"\n', 'utf8');
  await chmod(stub, 0o755);
  env = { ...process.env, PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ''}` };
});

afterAll(async () => {
  await rm(stubDir, { recursive: true, force: true }).catch(() => {});
});

const runInitCli = (repo: string, extra: string[] = []) =>
  execa('npx', ['tsx', CLI, '--repo', repo, ...extra, 'init'], { env, reject: false });

describe('copperhead init CLI: pre-commit hook reporting', () => {
  it('warns on stderr when a foreign hook is in the way', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await writeFile(path.join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nnpm run lint\n', 'utf8');
      const res = await runInitCli(repo);
      expect(res.stderr).toMatch(/pre-commit hook not installed/);
      expect(res.stderr).toMatch(/NOT active/);
      // The docs are still scaffolded, and the command still succeeds: the gate
      // being unavailable is not a reason to fail an init that did its job.
      expect(res.stdout).toMatch(/created docs\/BOM\.md/);
      expect(res.exitCode).toBe(0);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('says nothing about the hook when it installed one', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const res = await runInitCli(repo);
      expect(res.stderr).not.toMatch(/pre-commit hook not installed/);
      expect(res.stdout).toMatch(/created \.git\/hooks\/pre-commit/);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('--json carries hookSkipped and stdout stays parseable', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await writeFile(path.join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nnpm run lint\n', 'utf8');
      const res = await runInitCli(repo, ['--json']);
      // The warning goes to stderr precisely so it cannot corrupt the JSON.
      const parsed = JSON.parse(res.stdout) as { hookSkipped: string | null; created: string[] };
      expect(parsed.hookSkipped).toMatch(/already exists/);
      expect(parsed.created.some((f) => f.includes('pre-commit'))).toBe(false);
    } finally {
      await cleanup();
    }
  }, 60_000);
});
