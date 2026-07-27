#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { loadConfig, resolveModel, type ModelSource } from './config.js';
import { pickModel } from './util/select.js';
import { runInit, InitError } from './memory/scaffold.js';
import { runCheck } from './commands/check.js';
import { runDoctor, formatDoctor } from './commands/doctor.js';
import { syncVerify, syncResolve, formatSyncReport } from './commands/sync.js';
import { runCreate } from './commands/create.js';
import { runDemo, demoTourText } from './commands/demo.js';
import { runRepl } from './commands/repl.js';
import { runServe } from './commands/serve.js';
import {
  runExportBom,
  parseSupplier,
  parseBoards,
  parseSpares,
  ExportError,
} from './commands/export.js';
import { DEFAULT_BOARDS, DEFAULT_SPARES } from './kicad/bom-export.js';
import { runAgentLoop, type BudgetExhaustedStats } from './agent/loop.js';
import { makeRenderer } from './agent/render.js';
import { kicadCliVersion } from './kicad/cli.js';
import { KicadBridge } from './kicad/ipc.js';
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

/** `--max-turns` accepts only a positive integer; "5oops" and "NaN" refuse to start. */
function parseMaxTurns(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--max-turns must be a positive integer, got "${raw}"`);
  }
  return n;
}

async function confirmTty(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/**
 * Attended runs get a decision point instead of a rollback when the turn
 * budget runs out (issue #15). Non-TTY (CI, pipes) keeps fail-and-restore.
 */
function budgetContinuePrompt(): ((stats: BudgetExhaustedStats) => Promise<number>) | undefined {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  return async (stats) => {
    // ceil of the ORIGINAL budget (design D1), so repeat extensions offer the
    // same increment instead of escalating with the extended turn count.
    const extra = Math.ceil(stats.maxTurns / 2);
    const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
    const q = `Turn budget exhausted (${stats.turnsUsed} turns, ${k(stats.tokensIn)} in / ${k(stats.tokensOut)} out, ${stats.filesTouched.length} file(s) touched, ${stats.openObligations} open obligation(s)). Continue with ${extra} more turns?`;
    return (await confirmTty(q)) ? extra : 0;
  };
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
  .command('repl', { isDefault: true })
  .description('interactive agent shell (default when no command is given)')
  .argument('[request...]', 'optional first change request before the prompt loop')
  .option('--model <model>', 'codex | cursor | gpt-5 | claude | claude-code (or a provider-specific model id)')
  .option('--max-turns <n>', 'turn budget per request')
  .option('--interactive', 'pause for approval after each proposal validates')
  .action(
    async (
      requestParts: string[],
      opts: { model?: string; maxTurns?: string; interactive?: boolean },
    ) => {
      const repo = repoOf(program.opts());
      if (program.opts().json) {
        console.error(
          'copperhead: --json is not supported with the interactive shell. Use `copperhead do "<request>" --json`.',
        );
        process.exit(1);
      }
      try {
        const kicadVer = await kicadCliVersion();
        const config = await loadConfig(repo);
        const renderer = rendererOf();
        let model: string;
        let source: ModelSource;
        try {
          ({ model, source } = resolveModel(opts.model, config));
        } catch (err) {
          // No model anywhere (flag, COPPERHEAD_MODEL, config, .env keys):
          // on a TTY, offer an interactive pick instead of refusing to start.
          if (!process.stdin.isTTY || !process.stdout.isTTY) throw err;
          console.log('No model configured for this session, pick one:');
          const chosen = await pickModel();
          if (!chosen) throw err;
          model = chosen;
          source = 'picker';
        }
        const continuePrompt = budgetContinuePrompt();
        const seed = requestParts.length ? requestParts.join(' ') : undefined;
        const res = await runRepl({
          repoRoot: repo,
          model,
          modelSource: source,
          version,
          kicadCliVersion: kicadVer,
          ...(opts.maxTurns ? { maxTurns: parseMaxTurns(opts.maxTurns) } : {}),
          interactive: opts.interactive ?? false,
          ...(seed ? { seed } : {}),
          confirm: confirmTty,
          ...(continuePrompt ? { onBudgetExhausted: continuePrompt } : {}),
          renderer,
        });
        process.exit(res.ok ? 0 : 1);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    },
  );

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
  .command('doctor')
  .description('env preflight: kicad-cli, git, node, and the model provider credential; no LLM, no network')
  .option('--model <model>', 'model to check the provider credential for (default: resolved like a run)')
  .action(async (opts: { model?: string }) => {
    const repo = repoOf(program.opts());
    // Unlike other commands, doctor never gates on kicad-cli being present:
    // runDoctor probes it and reports a failure instead of throwing, so a user
    // with a missing tool still gets the full report.
    const report = await runDoctor({ repoRoot: repo, model: opts.model });
    if (program.opts().json) console.log(JSON.stringify(report, null, 2));
    else {
      const color = process.stdout.isTTY === true && !process.env.NO_COLOR;
      // || not ??: some non-interactive ptys report columns as 0.
      for (const line of formatDoctor(report, process.stdout.columns || 80, color)) console.log(line);
    }
    process.exit(report.ok ? 0 : 1);
  });

program
  .command('do')
  .description('the core loop: propose, edit, verify, propagate, commit')
  .argument('<request>', 'the change request in natural language')
  .option('--model <model>', 'codex | cursor | gpt-5 | claude | claude-code (or a provider-specific model id)')
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
      // KiCad IPC bridge (AC-114): `do` and the REPL are the only commands
      // that construct one; check/sync/create never touch the socket.
      const kicad = new KicadBridge({ reprobeMs: 0 });
      kicad.start();
      try {
        const kicadVer = await kicadCliVersion();
        const config = await loadConfig(repo);
        const { model, source } = resolveModel(opts.model, config);
        const continuePrompt = budgetContinuePrompt();
        const res = await runAgentLoop({
          repoRoot: repo,
          request,
          model,
          kicad,
          ...(opts.maxTurns ? { maxTurns: parseMaxTurns(opts.maxTurns) } : {}),
          allowDirty: opts.allowDirty ?? false,
          dryRun: opts.dryRun ?? false,
          interactive: opts.interactive ?? false,
          confirm: confirmTty,
          ...(continuePrompt ? { onBudgetExhausted: continuePrompt } : {}),
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
  .command('serve')
  .description('headless run surface: NDJSON over stdio for embedders (KiCad side panel)')
  .option('--model <model>', 'codex | cursor | gpt-5 | claude | claude-code (or a provider-specific model id)')
  .option('--max-turns <n>', 'turn budget per run')
  .action(async (opts: { model?: string; maxTurns?: string }) => {
    const repo = repoOf(program.opts());
    try {
      const kicadVer = await kicadCliVersion();
      const config = await loadConfig(repo);
      // No model is not fatal for serve: the handshake and `check` work
      // without one, and each `run` gets a no-model error with guidance.
      // Exiting here instead put embedders into a respawn loop (AC-114B.1).
      let model: string | null = null;
      let source: ModelSource | null = null;
      let modelError: string | undefined;
      try {
        ({ model, source } = resolveModel(opts.model, config));
      } catch (err) {
        modelError = (err as Error).message;
      }
      await runServe({
        repoRoot: repo,
        model,
        modelSource: source,
        ...(modelError !== undefined ? { modelError } : {}),
        version,
        kicadCliVersion: kicadVer,
        ...(opts.maxTurns ? { maxTurns: parseMaxTurns(opts.maxTurns) } : {}),
      });
      process.exit(0);
    } catch (err) {
      // stdout is the protocol channel; human-facing failures go to stderr.
      console.error((err as Error).message);
      process.exit(1);
    }
  });

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
  .command('demo')
  .description('tour of what copperhead does, or run the USB-C breakout create pipeline')
  .option('--model <model>', 'codex | cursor | gpt-5 | claude | claude-code (or a provider-specific model id)')
  .option('--interactive', 're-enable the human gates (spec approval, pre-export)')
  .option('--dir <path>', 'demo repo directory (default: demo-runs/usb-c-breakout)')
  .option('--tour', 'print the overview only; do not run the pipeline')
  .action(async (opts: { model?: string; interactive?: boolean; dir?: string; tour?: boolean }) => {
    if (opts.tour) {
      // Color on for attended TTY tours even without a renderer.
      const { setColorEnabled } = await import('./agent/theme.js');
      setColorEnabled(Boolean(process.stdout.isTTY) && !program.opts().plain && !process.env.NO_COLOR);
      console.log(demoTourText());
      process.exit(0);
    }
    try {
      const kicadVer = await kicadCliVersion();
      // Resolve model from the caller's cwd config / env / flag; the demo repo
      // is scaffolded next and typically has no model of its own yet.
      const config = await loadConfig(repoOf(program.opts()));
      const { model, source } = resolveModel(opts.model, config);
      const continuePrompt = budgetContinuePrompt();
      const res = await runDemo({
        model,
        modelSource: source,
        version,
        kicadCliVersion: kicadVer,
        interactive: opts.interactive ?? false,
        ...(opts.dir ? { demoDir: opts.dir } : {}),
        ...(continuePrompt ? { onBudgetExhausted: continuePrompt } : {}),
        log: (s) => console.log(s),
        renderer: rendererOf(),
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
  .option('--model <model>', 'codex | cursor | gpt-5 | claude | claude-code (or a provider-specific model id)')
  .option('--interactive', 're-enable the human gates (spec approval, pre-export)')
  .action(async (opts: { brief: string; model?: string; interactive?: boolean }) => {
    const repo = repoOf(program.opts());
    try {
      const kicadVer = await kicadCliVersion();
      const config = await loadConfig(repo);
      const { model, source } = resolveModel(opts.model, config);
      const continuePrompt = budgetContinuePrompt();
      const res = await runCreate({
        repoRoot: repo,
        briefPath: opts.brief,
        model,
        interactive: opts.interactive ?? false,
        ...(continuePrompt ? { onBudgetExhausted: continuePrompt } : {}),
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

const exportCmd = program
  .command('export')
  .description('emit supplier-ready files from repo state (deterministic; no LLM, no network)');

exportCmd
  .command('bom')
  .description('write a supplier-format BOM (jlcpcb | digikey | mouser) from docs/BOM.md')
  .requiredOption('--supplier <name>', 'jlcpcb | digikey | mouser')
  .option('--boards <n>', 'number of boards to order', String(DEFAULT_BOARDS))
  .option('--spares <percent>', 'spare parts percentage', String(DEFAULT_SPARES))
  .option('--include-unverified', 'include UNVERIFIED rows that carry an MPN (never MPN-less rows)')
  .action(async (opts: { supplier: string; boards: string; spares: string; includeUnverified?: boolean }) => {
    const repo = repoOf(program.opts());
    const json = Boolean(program.opts().json);
    try {
      const supplier = parseSupplier(opts.supplier);
      const boards = parseBoards(opts.boards);
      const spares = parseSpares(opts.spares);
      const res = await runExportBom({
        repoRoot: repo,
        supplier,
        boards,
        spares,
        includeUnverified: opts.includeUnverified ?? false,
      });
      // Warnings go to stderr so a `> file` redirect of stdout stays clean and
      // the excluded-rows report is still seen.
      for (const w of res.warnings) console.error(w);
      if (json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(`wrote ${res.outPath} (${res.included.length} part(s), ${res.excluded.length} excluded)`);
      }
      process.exit(0);
    } catch (err) {
      // ExportError carries an actionable message (bad flag, missing BOM, drift);
      // anything else is unexpected. Both exit non-zero with no stack trace.
      console.error(err instanceof ExportError ? err.message : (err as Error).message);
      process.exit(1);
    }
  });

program.parseAsync().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
