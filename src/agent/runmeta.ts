import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import { loadConstraints } from '../memory/constraints.js';
import { kicadCliVersion } from '../kicad/cli.js';
import { branchName, headCommit, uncommittedCount } from '../util/git.js';
import type { CopperheadConfig, ModelSource } from '../config.js';

/** Caller-supplied run identity: facts the loop cannot probe for itself. */
export interface RunMetaInput {
  command?: 'do' | 'create' | 'sync';
  modelSource?: ModelSource;
  version?: string;
  kicadCliVersion?: string;
  stage?: { name: string; index: number; total: number };
  brief?: { path: string; sha256: string };
}

/**
 * Everything a run needs to be self-describing (AC-8.1). Collected once,
 * rendered onto three surfaces: run-start event, summary.md ## Environment,
 * and the live CLI header. Probe failures are nulls, never errors (AC-8.3).
 */
export interface RunMeta {
  request: string;
  model: string;
  provider: string;
  modelSource: ModelSource | null;
  runId: string;
  startedAt: string;
  command: 'do' | 'create' | 'sync' | null;
  interactive: boolean;
  stage: { name: string; index: number; total: number } | null;
  brief: { path: string; sha256: string } | null;
  versions: {
    copperhead: string | null;
    installPath: string | null;
    kicadCli: string | null;
    node: string;
    platform: string;
  };
  config: {
    schematic: string | null;
    board: string | null;
    docs: string;
    maxTurns: number;
    maxRepairCycles: number;
    budgets: Record<string, number>;
  };
  git: {
    commit: string | null;
    branch: string | null;
    dirty: boolean | null;
    uncommittedFiles: number | null;
    preCommitHookInstalled: boolean | null;
  };
  openConstraints: number | null;
  priorRuns: number | null;
}

/** A metadata probe must never fail the run it describes (design D4). */
async function probe<T>(fn: () => Promise<T> | T): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

function packageRoot(): string {
  // src/agent/ and dist/agent/ both sit two levels below the package root.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function ownVersion(): string {
  const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };
  return version;
}

export interface CollectRunMetaOptions {
  repoRoot: string;
  config: CopperheadConfig;
  /** Effective turn budget for this run (flag override already applied). */
  maxTurns: number;
  runId: string;
  request: string;
  model: string;
  provider: string;
  interactive: boolean;
  input?: RunMetaInput | undefined;
}

export async function collectRunMeta(opts: CollectRunMetaOptions): Promise<RunMeta> {
  const { repoRoot, config, input } = opts;
  const [copperhead, kicadCli, commit, branch, uncommitted, hook, openConstraints, priorRuns] = await Promise.all([
    probe(() => input?.version ?? ownVersion()),
    probe(() => input?.kicadCliVersion ?? kicadCliVersion()),
    probe(() => headCommit(repoRoot)),
    probe(() => branchName(repoRoot)),
    probe(() => uncommittedCount(repoRoot)),
    probe(async () => {
      const hookText = await readFile(path.join(repoRoot, '.git', 'hooks', 'pre-commit'), 'utf8');
      return hookText.includes('copperhead');
    }).then((v) => v ?? false),
    probe(async () => Object.keys(await loadConstraints(repoRoot)).length),
    probe(async () => {
      const entries = await readdir(path.join(repoRoot, '.copperhead', 'runs'));
      return entries.filter((e) => e !== opts.runId).length;
    }).then((v) => v ?? 0),
  ]);

  return {
    request: opts.request,
    model: opts.model,
    provider: opts.provider,
    modelSource: input?.modelSource ?? null,
    runId: opts.runId,
    startedAt: new Date().toISOString(),
    command: input?.command ?? null,
    interactive: opts.interactive,
    stage: input?.stage ?? null,
    brief: input?.brief ?? null,
    versions: {
      copperhead,
      installPath: await probe(packageRoot),
      kicadCli,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    config: {
      schematic: config.schematic,
      board: config.board,
      docs: config.docs,
      maxTurns: opts.maxTurns,
      maxRepairCycles: config.maxRepairCycles,
      budgets: config.budgets,
    },
    git: {
      commit,
      branch,
      dirty: uncommitted === null ? null : uncommitted > 0,
      uncommittedFiles: uncommitted,
      preCommitHookInstalled: hook,
    },
    openConstraints,
    priorRuns,
  };
}

const unk = (v: string | null | undefined): string => v ?? 'unknown';

/** ≤ 2 lines, printed before the first turn (AC-8.4). */
export function renderCliHeader(meta: RunMeta): string[] {
  const v = meta.versions;
  const line1 = [
    `copperhead v${unk(v.copperhead)}${v.installPath ? ` (${v.installPath})` : ''}`,
    `kicad-cli ${unk(v.kicadCli)}`,
    `node ${v.node}`,
    v.platform,
  ].join(' · ');

  const repoState =
    meta.git.dirty === null
      ? 'unknown'
      : meta.git.dirty
        ? `dirty(${meta.git.uncommittedFiles})`
        : 'clean';
  const line2 = [
    `run ${meta.runId}`,
    unk(meta.command),
    ...(meta.stage ? [`stage ${meta.stage.name} (${meta.stage.index}/${meta.stage.total})`] : []),
    `model ${meta.model} (${meta.provider}, via ${unk(meta.modelSource)})`,
    `turns ≤${meta.config.maxTurns}`,
    `repo ${unk(meta.git.branch)}@${meta.git.commit?.slice(0, 7) ?? 'unknown'} ${repoState}`,
  ].join(' · ');
  return [line1, line2];
}

/** The `## Environment` section of summary.md; values mirror the run-start event (AC-8.4). */
export function renderEnvironmentSection(meta: RunMeta): string[] {
  const v = meta.versions;
  const c = meta.config;
  const g = meta.git;
  return [
    `## Environment`,
    ``,
    `- **Run:** ${meta.runId} · ${unk(meta.command)} · started ${meta.startedAt} · ${meta.interactive ? 'interactive' : 'autonomous'}`,
    ...(meta.stage ? [`- **Stage:** ${meta.stage.name} (${meta.stage.index}/${meta.stage.total})`] : []),
    ...(meta.brief ? [`- **Brief:** ${meta.brief.path} (sha256 ${meta.brief.sha256.slice(0, 12)}…)`] : []),
    `- **Model:** ${meta.model} (${meta.provider}, via ${unk(meta.modelSource)})`,
    `- **copperhead:** v${unk(v.copperhead)}${v.installPath ? ` at ${v.installPath}` : ''}`,
    `- **Tooling:** kicad-cli ${unk(v.kicadCli)} · node ${v.node} · ${v.platform}`,
    `- **Config:** schematic ${c.schematic ?? 'null'} · board ${c.board ?? 'null'} · docs ${c.docs} · maxTurns ${c.maxTurns} · maxRepairCycles ${c.maxRepairCycles} · budgets ${JSON.stringify(c.budgets)}`,
    `- **Repo:** ${unk(g.branch)}@${g.commit ?? 'unknown'} · ${g.dirty === null ? 'unknown' : g.dirty ? `dirty (${g.uncommittedFiles} uncommitted)` : 'clean'} · pre-commit hook ${g.preCommitHookInstalled === null ? 'unknown' : g.preCommitHookInstalled ? 'installed' : 'absent'}`,
    `- **Memory:** ${meta.openConstraints ?? 'unknown'} open constraint(s) · ${meta.priorRuns ?? 'unknown'} prior run(s)`,
  ];
}
