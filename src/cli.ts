#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { loadConfig, resolveModel } from './config.js';
import { runInit, InitError } from './memory/scaffold.js';
import { runCheck } from './commands/check.js';
import { syncVerify, syncResolve, formatSyncReport } from './commands/sync.js';
import { runCreate } from './commands/create.js';
import { runAgentLoop } from './agent/loop.js';
import { makeRenderer } from './agent/render.js';
import { kicadCliVersion } from './kicad/cli.js';
import { loadEnvFile } from './util/env.js';

// Read .env from the working directory before any command resolves a model or a
// provider. Loaded here rather than per-command so `check` behaves identically,
// though check never reads a key: it stays LLM-free and network-free either way.
// A real environment variable always beats the file.
loadEnvFile(process.cwd());

// Single source of truth for the version. Both src/cli.ts (via tsx) and
// dist/cli.js sit one level below the package root, so the path holds either
// way, and a release can never ship a version string that disagrees with the
// package it was published as.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const program = new Command();

const repoOf = (opts: { repo?: string }): string => path.resolve(opts.repo ?? process.cwd());

async function confirmTty(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

program
  .name('copperhead')
  .description('Cursor for circuit boards: an AI agent for real KiCad repositories')
  .version(version)
  .option('--repo <path>', 'target repository (default: cwd)')
  .option('--json', 'machine-readable output')
  .option('--plain', 'plain log-style output (no interactive status line)');

const rendererOf = () =>
  makeRenderer({ json: Boolean(program.opts().json), plain: Boolean(program.opts().plain) });

program
  .command('init')
  .description('scaffold docs/ from an existing schematic; idempotent')
  .option('--path <dir>', 'where to look for KiCad files', '.')
  .option('--force', 'overwrite hand-edited generated docs')
  .option('--no-hooks', 'skip git pre-commit hook installation')
  .action(async (opts: { path: string; force?: boolean; hooks: boolean }) => {
    const repo = repoOf(program.opts());
    try {
      await kicadCliVersion();
      const res = await runInit({
        repoRoot: repo,
        searchPath: opts.path,
        force: opts.force ?? false,
        installHooks: opts.hooks,
      });
      if (program.opts().json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        for (const f of res.created) console.log(`created ${f}`);
        for (const f of res.skipped) console.log(`unchanged ${f}`);
        for (const f of res.refused) console.log(`REFUSED (hand-edited; use --force): ${f}`);
      }
      process.exit(res.refused.length ? 1 : 0);
    } catch (err) {
      console.error(err instanceof InitError ? err.message : (err as Error).message);
      process.exit(1);
    }
  });

const checkAction = async (): Promise<void> => {
  const repo = repoOf(program.opts());
  const json = Boolean(program.opts().json);
  try {
    await kicadCliVersion();
    const res = await runCheck(repo, json ? () => {} : (s) => console.log(s));
    if (json) console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
};

program
  .command('check')
  .alias('verify')
  .description('ERC + DRC + doc-drift + spec validation; no LLM calls; CI-safe')
  .action(checkAction);

program
  .command('do')
  .description('the core loop: propose, edit, verify, propagate, commit')
  .argument('<request>', 'the change request in natural language')
  .option('--model <model>', 'gpt-5 | claude (or a full model id)')
  .option('--max-turns <n>', 'turn budget for this run')
  .option('--allow-dirty', 'allow a dirty tree (snapshot via git stash create)')
  .option('--dry-run', 'propose the diff, write nothing')
  .option('--interactive', 'pause for approval after the proposal validates')
  .action(
    async (
      request: string,
      opts: { model?: string; maxTurns?: string; allowDirty?: boolean; dryRun?: boolean; interactive?: boolean },
    ) => {
      const repo = repoOf(program.opts());
      try {
        const kicadVer = await kicadCliVersion();
        const config = await loadConfig(repo);
        const { model, source } = resolveModel(opts.model, config);
        const res = await runAgentLoop({
          repoRoot: repo,
          request,
          model,
          ...(opts.maxTurns ? { maxTurns: parseInt(opts.maxTurns, 10) } : {}),
          allowDirty: opts.allowDirty ?? false,
          dryRun: opts.dryRun ?? false,
          interactive: opts.interactive ?? false,
          confirm: confirmTty,
          renderer: rendererOf(),
          meta: { command: 'do', modelSource: source, version, kicadCliVersion: kicadVer },
        });
        if (program.opts().json) console.log(JSON.stringify(res, null, 2));
        process.exit(res.outcome === 'failure' ? 1 : 0);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    },
  );

program
  .command('sync')
  .description('verify the whole design state for inconsistencies and resolve drift')
  .option('--model <model>', 'model for the resolve phase')
  .option('--dry-run', 'print the inconsistency report, write nothing')
  .action(async (opts: { model?: string; dryRun?: boolean }) => {
    const repo = repoOf(program.opts());
    try {
      const kicadVer = await kicadCliVersion();
      const report = await syncVerify(repo);
      const json = Boolean(program.opts().json);
      if (json) console.log(JSON.stringify(report, null, 2));
      else console.log(formatSyncReport(report));
      if (opts.dryRun) {
        process.exit(report.violations.length ? 2 : 0);
      }
      if (report.violations.length) {
        // requirement violations are never auto-resolved (AC-7.3)
        process.exit(2);
      }
      if (!report.resolvable.length) {
        process.exit(0);
      }
      const config = await loadConfig(repo);
      const { model, source } = resolveModel(opts.model, config);
      const res = await syncResolve(repo, report, model, json ? () => {} : (s) => console.log(s), {
        renderer: rendererOf(),
        meta: { command: 'sync', modelSource: source, version, kicadCliVersion: kicadVer },
      });
      process.exit(res.ok ? 0 : 1);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command('create')
  .description('Mode A: full pipeline from a product brief to the output package')
  .requiredOption('--brief <file>', 'product brief (markdown)')
  .option('--model <model>', 'gpt-5 | claude')
  .option('--interactive', 're-enable the human gates (spec approval, pre-export)')
  .action(async (opts: { brief: string; model?: string; interactive?: boolean }) => {
    const repo = repoOf(program.opts());
    try {
      const kicadVer = await kicadCliVersion();
      const config = await loadConfig(repo);
      const { model, source } = resolveModel(opts.model, config);
      const res = await runCreate({
        repoRoot: repo,
        briefPath: opts.brief,
        model,
        interactive: opts.interactive ?? false,
        log: (s) => console.log(s),
        renderer: rendererOf(),
        meta: { command: 'create', modelSource: source, version, kicadCliVersion: kicadVer },
      });
      process.exit(res.ok ? 0 : 1);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program.parseAsync().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
