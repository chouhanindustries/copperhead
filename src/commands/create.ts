import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadConfig } from '../config.js';
import { bootstrapKicadProject } from '../kicad/bootstrap.js';
import { exportSvg, runErc } from '../kicad/cli.js';
import { listSymbols } from '../kicad/sexp.js';
import { isDirty, commitAll, changedFiles } from '../util/git.js';
import type { CopperheadConfig } from '../config.js';
import { checkDrift } from '../memory/drift.js';
import { runAgentLoop, makeProvider, type BudgetExhaustedStats } from '../agent/loop.js';
import { diagnoseStageFailure, transcriptExcerpt, withTimeout, type StageDiagnosis } from '../agent/recovery.js';
import type { Provider } from '../agent/types.js';
import type { RunMetaInput } from '../agent/runmeta.js';
import { fmtDuration, fmtTokens, type ProgressRenderer } from '../agent/render.js';
import { openspecInit } from '../openspec/cli.js';
import { sweepStaleTempDirs, pruneHistoryDir } from '../util/tmp.js';
import { assertDiskSpace, DEFAULT_MIN_FREE_BYTES } from '../util/preflight.js';
import { runCheck } from './check.js';
import { emitCreateJlcpcbBom } from './export.js';

/**
 * Mode A (`copperhead create`, SPEC §2.5): staged pipeline, each stage a
 * do-loop run with a stage prompt and gate. Stage completion is inferred from
 * repo state, which makes the pipeline resumable for free (design D10).
 * Run-to-completion: gates are quality checks the agent must satisfy, not
 * stops that wait for a human (unless --interactive).
 */
interface Stage {
  name: string;
  /** true when repo state shows the stage is already done (resume support). */
  isComplete: (repoRoot: string, docs: string) => Promise<boolean> | boolean;
  prompt: (brief: string) => string;
}

const docExists = (repoRoot: string, rel: string) => existsSync(path.join(repoRoot, rel));

async function docHasContent(repoRoot: string, rel: string, marker: string): Promise<boolean> {
  const p = path.join(repoRoot, rel);
  if (!existsSync(p)) return false;
  return (await readFile(p, 'utf8')).includes(marker);
}

// Heading-aware variant of docHasContent: matches any Markdown heading whose
// text contains `word`, ignoring heading level, leading numbering ("3."), and
// trailing decoration ("Budgets and constraints (...)"). Stage prompts don't
// dictate exact heading text, so a literal `.includes('## Budgets')` produces
// false negatives against valid docs titled e.g. "## 3. Budgets and constraints".
async function docHasHeading(repoRoot: string, rel: string, word: string): Promise<boolean> {
  const p = path.join(repoRoot, rel);
  if (!existsSync(p)) return false;
  const re = new RegExp(`^#{1,6}\\s.*\\b${word}\\b`, 'im');
  return re.test(await readFile(p, 'utf8'));
}

export const STAGES: Stage[] = [
  {
    name: 'spec-seed',
    isComplete: (root, docs) => docHasHeading(root, path.join(docs, 'SPEC.md'), 'Budgets'),
    prompt: (brief) =>
      `Stage 1 of the create pipeline: seed the requirements. From the product brief below, write docs/SPEC.md (what the device is, top-level constraints and budgets). Every budget you state must also be recorded with record_constraint. Anything the brief does not state: propose a sensible default and flag it ASSUMED. If an openspec/ workspace exists, also seed openspec/specs/ with per-capability requirements using Given/When/Then scenarios.\n\nBrief:\n${brief}`,
  },
  {
    name: 'architecture',
    isComplete: (root, docs) => docExists(root, path.join(docs, 'SUBSYSTEMS.md')),
    prompt: () =>
      'Stage 2: architecture. Write docs/SUBSYSTEMS.md: the block diagram in prose, one section per subsystem (power, MCU, connectivity, UI, ...), with the reasoning and key values for each. Respect every budget in SPEC.md.',
  },
  {
    name: 'part-selection',
    isComplete: (root, docs) => docExists(root, path.join(docs, 'BOM.md')),
    prompt: () =>
      'Stage 3: part selection. Write docs/BOM.md with the fixed table format (| Refdes | Value | Footprint | MPN | Rationale |). Every MPN you introduce is flagged UNVERIFIED with a datasheet-verifiable justification. Check leakage/quiescent current of every part against the power budget. Run check_drift before finishing.',
  },
  {
    name: 'schematic',
    isComplete: async (root) => {
      const config = await loadConfig(root);
      if (!config.schematic) return false;
      const p = path.join(root, config.schematic);
      if (!existsSync(p)) return false;
      if (!(await listSymbols(p)).length) return false;
      if ((await checkDrift(root, config.docs, config.schematic)).length !== 0) return false;
      return (await runErc(p)).ok;
    },
    prompt: () =>
      'Stage 4: schematic. An empty KiCad project has already been scaffolded and wired into .copperhead/config.json (an empty schematic and a blank board with a default outline). Populate the existing schematic with edit_file — write_file refuses KiCad files, so add lib_symbols, symbols, and connectivity by anchored edits into the file that already exists. Work ONE part at a time, not in large blocks: add a symbol (its lib_symbols entry if new, then its placement), run run_erc, fix any violation, then move to the next part — small incremental edits keep a geometry or grid slip local instead of forcing a full-block rewrite. When you add a lib_symbols entry, use the exact canonical KiCad lib_id (e.g. Device:R, Connector:USB_C_Receptacle_USB2.0_16P) and reproduce the real part\'s pins faithfully — never invent pin numbers, names, or electrical types. Once symbols are placed, run verify_symbols and reconcile every divergence it reports (a wrong lib_id or pin set passes ERC but is still wrong); if it flags a renamed symbol, adopt the real name it suggests. Build subsystem by subsystem from BOM.md and SUBSYSTEMS.md. Same net names and refdes everywhere. Two KiCad rules the pipeline has repeatedly tripped on: (1) a net label placed on a pin only NAMES the net — it is NOT an electrical connection unless a wire actually reaches the pin; ERC will report the pin unconnected until you draw the wire. (2) Place every symbol origin and every wire endpoint on the 1.27mm (50mil) grid; an off-grid pin silently fails to connect and costs turns to diagnose. Update PINOUT.md as you assign pins; check the strapping table first.',
  },
  {
    name: 'layout-draft',
    isComplete: async (root, docs) => {
      const config = await loadConfig(root);
      if (!config.board) return false;
      const p = path.join(root, config.board);
      if (!existsSync(p)) return false;
      if (!(await readFile(p, 'utf8')).includes('(footprint')) return false;
      return docHasHeading(root, path.join(docs, 'LAYOUT.md'), 'Draft quality');
    },
    prompt: () =>
      'Stage 5: first-draft layout. Rule-driven placement written as real coordinates: connectors on edges, decoupling at IC pins, ESD at connectors, keepouts honored. Route power and short critical nets; leave the rest as ratsnest. Every routed net must pass run_drc. Then write the "## Draft quality" section in LAYOUT.md: exactly what is fine and what a human or specialist tool should redo. Non-optimal is acceptable; unlabeled non-optimal is not.',
  },
  {
    name: 'outputs',
    isComplete: (root) => existsSync(path.join(root, 'outputs')),
    prompt: () =>
      'Stage 6: outputs package. Export into outputs/: gerbers+drill (JLC profile), DXF and STEP outline, SVG renders (export_svg), and an ordering BOM.csv generated from BOM.md (refdes, MPN, qty). Every export must succeed.',
  },
  {
    name: 'firmware',
    isComplete: (root) => existsSync(path.join(root, 'firmware')),
    prompt: () =>
      'Stage 7: firmware scaffold. Generate firmware/ for the chosen MCU HAL: pins.h generated from PINOUT.md (single source of truth), driver stubs, and one working happy path. If the vendor toolchain is available, the build must pass; if not, note "not compiled here" explicitly in DEVPLAN.md.',
  },
  {
    name: 'devplan',
    isComplete: (root, docs) => docExists(root, path.join(docs, 'DEVPLAN.md')),
    prompt: () =>
      'Stage 8: DEVPLAN.md. Write docs/DEVPLAN.md: bring-up steps in order, test points and what to meter first, risk list, and the prototype order plan.',
  },
];

export interface CreateOptions {
  repoRoot: string;
  briefPath: string;
  model: string;
  interactive?: boolean;
  onBudgetExhausted?: (stats: BudgetExhaustedStats) => Promise<number>;
  log: (s: string) => void;
  renderer?: ProgressRenderer;
  meta?: Omit<RunMetaInput, 'stage' | 'brief'>;
}

async function emitJlcpcbAfterOutputs(stageName: string, opts: CreateOptions): Promise<void> {
  if (stageName !== 'outputs') return;
  const out = await emitCreateJlcpcbBom(opts.repoRoot);
  if (out) opts.log(`stage outputs: emitted ${out} (JLCPCB assembly BOM)`);
}

const KICAD_STAGES = new Set(['schematic', 'layout-draft', 'outputs']);

function isManagedPath(f: string, config: CopperheadConfig): boolean {
  const docsDir = config.docs.replace(/\/+$/, '');
  return (
    f === docsDir ||
    f.startsWith(`${docsDir}/`) ||
    f.startsWith('.copperhead/') ||
    f.startsWith('openspec/') ||
    f.startsWith('outputs/') ||
    f.startsWith('firmware/') ||
    f === '.gitignore' ||
    /\.(kicad_sch|kicad_pcb|kicad_pro|kicad_prl)$/.test(f)
  );
}

async function commitResumedStage(opts: CreateOptions, config: CopperheadConfig, stageName: string): Promise<void> {
  if (!(await isDirty(opts.repoRoot))) return;
  const dirty = await changedFiles(opts.repoRoot, 'HEAD');
  const foreign = dirty.filter((f) => !isManagedPath(f, config));
  if (foreign.length) {
    opts.log(
      `stage ${stageName}: already-complete work is uncommitted, but the tree also has non-copperhead changes ` +
        `(${foreign.slice(0, 3).join(', ')}${foreign.length > 3 ? ', …' : ''}); leaving it uncommitted so nothing of yours is swept up`,
    );
    return;
  }
  try {
    const sha = await commitAll(opts.repoRoot, `copperhead: resume — commit completed stage ${stageName}`);
    opts.log(`stage ${stageName}: committed already-complete work ${sha.slice(0, 10)} so a later rollback cannot wipe it (2.4)`);
  } catch (err) {
    opts.log(`stage ${stageName}: could not commit resumed work (${(err as Error).message})`);
  }
}

async function renderStageArtifacts(opts: CreateOptions, stageName: string, transcriptDir: string): Promise<void> {
  if (!KICAD_STAGES.has(stageName) || !transcriptDir) return;
  const config = await loadConfig(opts.repoRoot);
  const targets: Array<{ kind: 'sch' | 'pcb'; file: string }> = [];
  if (config.schematic && existsSync(path.join(opts.repoRoot, config.schematic))) {
    targets.push({ kind: 'sch', file: config.schematic });
  }
  if (config.board && existsSync(path.join(opts.repoRoot, config.board))) {
    targets.push({ kind: 'pcb', file: config.board });
  }
  if (!targets.length) return;
  const artifactsDir = path.join(transcriptDir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  let rendered = 0;
  for (const { kind, file } of targets) {
    try {
      await exportSvg(kind, path.join(opts.repoRoot, file), artifactsDir);
      rendered++;
    } catch (err) {
      opts.log(`stage ${stageName}: could not render ${kind} SVG (${(err as Error).message})`);
    }
  }
  if (rendered) {
    opts.log(`stage ${stageName}: rendered ${rendered} SVG artifact(s) into ${path.relative(opts.repoRoot, artifactsDir)}/`);
  }
}

async function diagnose(input: {
  model: string;
  timeoutMs: number;
  stageName: string;
  stageGoal: string;
  failure: string;
  transcriptDir: string;
  attempt: number;
  maxAttempts: number;
}): Promise<StageDiagnosis> {
  let provider: Provider | undefined;
  try {
    provider = await makeProvider(input.model);
    const p = provider;
    const excerpt = await transcriptExcerpt(input.transcriptDir);
    return await withTimeout(
      () =>
        diagnoseStageFailure(p, {
          stageName: input.stageName,
          stageGoal: input.stageGoal,
          failure: input.failure,
          excerpt,
          attempt: input.attempt,
          maxAttempts: input.maxAttempts,
        }),
      input.timeoutMs,
      () => p.close?.(),
    );
  } catch (e) {
    return { verdict: 'abort', reason: `diagnosis unavailable: ${(e as Error).message}` };
  } finally {
    await provider?.close?.();
  }
}

interface StageCost {
  name: string;
  resumed: boolean;
  wallMs: number;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  cacheHits: number;
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function resumeCommand(opts: CreateOptions): string {
  const parts = ['copperhead'];
  const repo = path.resolve(opts.repoRoot);
  if (repo !== process.cwd()) parts.push('--repo', shellQuote(repo));
  parts.push('create', '--brief', shellQuote(path.resolve(opts.briefPath)), '--model', shellQuote(opts.model));
  if (opts.interactive) parts.push('--interactive');
  return parts.join(' ');
}

function logResumePoint(opts: CreateOptions, stage: Stage, index: number): void {
  opts.log('');
  opts.log(`⏸  stopped at stage ${index + 1}/${STAGES.length} (${stage.name}). To resume from here, run:`);
  opts.log(`     ${resumeCommand(opts)}`);
  opts.log(
    `   (${index} stage(s) already complete are detected from repo state and skipped; it resumes at ${stage.name}.)`,
  );
}

function printCostTable(opts: CreateOptions, costs: StageCost[]): void {
  if (!costs.length) return;
  const pct = (hits: number, turns: number): string => (turns ? `${Math.round((hits / turns) * 100)}%` : '—');
  const header = { stage: 'Stage', wall: 'Wall', turns: 'Turns', out: 'Out tok', cache: 'Cache' };
  const rows = costs.map((c) => ({
    stage: c.name,
    wall: c.resumed ? '—' : fmtDuration(c.wallMs),
    turns: c.resumed ? '—' : String(c.turns),
    out: c.resumed ? '—' : fmtTokens(c.tokensOut),
    cache: c.resumed ? '—' : pct(c.cacheHits, c.turns),
  }));
  const ran = costs.filter((c) => !c.resumed);
  const total =
    ran.length &&
    ({
      stage: 'TOTAL',
      wall: fmtDuration(ran.reduce((a, c) => a + c.wallMs, 0)),
      turns: String(ran.reduce((a, c) => a + c.turns, 0)),
      out: fmtTokens(ran.reduce((a, c) => a + c.tokensOut, 0)),
      cache: pct(
        ran.reduce((a, c) => a + c.cacheHits, 0),
        ran.reduce((a, c) => a + c.turns, 0),
      ),
    } as const);
  const all = [header, ...rows, ...(total ? [total] : [])];
  const w = {
    stage: Math.max(...all.map((r) => r.stage.length)),
    wall: Math.max(...all.map((r) => r.wall.length)),
    turns: Math.max(...all.map((r) => r.turns.length)),
    out: Math.max(...all.map((r) => r.out.length)),
    cache: Math.max(...all.map((r) => r.cache.length)),
  };
  const line = (r: typeof header): string =>
    `  ${r.stage.padEnd(w.stage)}  ${r.wall.padStart(w.wall)}  ${r.turns.padStart(w.turns)}  ${r.out.padStart(w.out)}  ${r.cache.padStart(w.cache)}`;
  const rule = `  ${'-'.repeat(w.stage)}  ${'-'.repeat(w.wall)}  ${'-'.repeat(w.turns)}  ${'-'.repeat(w.out)}  ${'-'.repeat(w.cache)}`;
  opts.log('');
  opts.log('Per-stage cost summary (5.2):');
  opts.log(line(header));
  opts.log(rule);
  for (const r of rows) opts.log(line(r));
  if (total) {
    opts.log(rule);
    opts.log(line(total));
  }
}

function ranTotals(stageCosts: StageCost[]): {
  wallMs: number;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  cacheHits: number;
} {
  const ran = stageCosts.filter((c) => !c.resumed);
  return {
    wallMs: ran.reduce((a, c) => a + c.wallMs, 0),
    turns: ran.reduce((a, c) => a + c.turns, 0),
    tokensIn: ran.reduce((a, c) => a + c.tokensIn, 0),
    tokensOut: ran.reduce((a, c) => a + c.tokensOut, 0),
    cacheHits: ran.reduce((a, c) => a + c.cacheHits, 0),
  };
}

const cachePct = (hits: number, turns: number): number => (turns ? Math.round((hits / turns) * 100) : 0);

function logCumulative(opts: CreateOptions, stageCosts: StageCost[]): void {
  const t = ranTotals(stageCosts);
  if (!t.turns && !t.wallMs) return;
  opts.log(
    `pipeline so far: ${stageCosts.length}/${STAGES.length} stages · ${fmtDuration(t.wallMs)} · ` +
      `${fmtTokens(t.tokensOut)} out tokens · ${cachePct(t.cacheHits, t.turns)}% cache hits`,
  );
}

async function writeRunReport(opts: CreateOptions, stageCosts: StageCost[]): Promise<void> {
  if (!stageCosts.length) return;
  const runsDir = path.join(opts.repoRoot, '.copperhead', 'runs');
  const t = ranTotals(stageCosts);
  const ran = stageCosts.filter((c) => !c.resumed);
  const slowest = ran.length ? ran.reduce((a, b) => (b.wallMs > a.wallMs ? b : a)) : null;
  const priciest = ran.length ? ran.reduce((a, b) => (b.tokensOut > a.tokensOut ? b : a)) : null;

  const report = {
    generatedAtMs: Date.now(),
    stageCount: STAGES.length,
    ran: ran.length,
    resumed: stageCosts.length - ran.length,
    stages: stageCosts.map((c) => ({
      name: c.name,
      resumed: c.resumed,
      wallMs: c.wallMs,
      turns: c.turns,
      tokensIn: c.tokensIn,
      tokensOut: c.tokensOut,
      cacheHits: c.cacheHits,
      cacheHitPct: c.resumed ? null : cachePct(c.cacheHits, c.turns),
    })),
    total: { ...t, cacheHitPct: cachePct(t.cacheHits, t.turns) },
    slowestStage: slowest ? { name: slowest.name, wallMs: slowest.wallMs } : null,
    mostExpensiveStage: priciest ? { name: priciest.name, tokensOut: priciest.tokensOut } : null,
  };

  const row = (cells: string[]): string => `| ${cells.join(' | ')} |`;
  const lines = [
    '# Copperhead run report',
    '',
    'Per-stage cost of the create pipeline, regenerated at the end of every run.',
    'Resumed stages were already complete on entry and cost nothing this run.',
    '',
    row(['Stage', 'Wall', 'Turns', 'In', 'Out', 'Cache', 'Status']),
    row(['---', '---:', '---:', '---:', '---:', '---:', '---']),
    ...stageCosts.map((c) =>
      c.resumed
        ? row([c.name, '—', '—', '—', '—', '—', 'resumed'])
        : row([
            c.name,
            fmtDuration(c.wallMs),
            String(c.turns),
            fmtTokens(c.tokensIn),
            fmtTokens(c.tokensOut),
            `${cachePct(c.cacheHits, c.turns)}%`,
            'ran',
          ]),
    ),
    row([
      '**Total**',
      fmtDuration(t.wallMs),
      String(t.turns),
      fmtTokens(t.tokensIn),
      fmtTokens(t.tokensOut),
      `${cachePct(t.cacheHits, t.turns)}%`,
      '',
    ]),
    '',
  ];
  if (slowest && priciest) {
    lines.push(
      `Slowest stage: **${slowest.name}** (${fmtDuration(slowest.wallMs)}). ` +
        `Most expensive: **${priciest.name}** (${fmtTokens(priciest.tokensOut)} out tokens).`,
      '',
    );
  }

  try {
    await mkdir(runsDir, { recursive: true });
    await writeFile(path.join(runsDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    await writeFile(path.join(runsDir, 'REPORT.md'), lines.join('\n'), 'utf8');
    opts.log(`wrote run report: ${path.relative(opts.repoRoot, path.join(runsDir, 'REPORT.md'))} (+ report.json)`);
  } catch (err) {
    opts.log(`warning: could not write run report (${(err as Error).message})`);
  }
}

export async function runCreate(opts: CreateOptions): Promise<{ ok: boolean; completed: string[] }> {
  const brief = await readFile(path.resolve(opts.briefPath), 'utf8');
  const briefMeta = { path: opts.briefPath, sha256: createHash('sha256').update(brief).digest('hex') };
  const config = await loadConfig(opts.repoRoot);
  const minFreeMb = Number(process.env.COPPERHEAD_MIN_FREE_MB);
  const minFree = Number.isFinite(minFreeMb) && minFreeMb >= 0 ? minFreeMb * 1024 * 1024 : DEFAULT_MIN_FREE_BYTES;
  await assertDiskSpace(opts.repoRoot, minFree);
  const swept = await sweepStaleTempDirs(Date.now());
  if (swept.length) opts.log(`startup: reclaimed ${swept.length} stale temp dir(s) from earlier runs`);
  const pruned = await pruneHistoryDir(opts.repoRoot);
  if (pruned) opts.log(`startup: pruned ${pruned} old .history/ entrie(s) to cap local-history growth`);
  await openspecInit(opts.repoRoot);
  const completed: string[] = [];
  const stageCosts: StageCost[] = [];

  for (const [i, stage] of STAGES.entries()) {
    if (stage.name === 'schematic') {
      const created = await bootstrapKicadProject(opts.repoRoot, brief);
      if (created) opts.log(`stage schematic: scaffolded empty KiCad project (${created} + board + project), wired into config`);
    }
    if (await stage.isComplete(opts.repoRoot, config.docs)) {
      opts.log(`stage ${stage.name}: already complete (resuming past it)`);
      await commitResumedStage(opts, config, stage.name);
      completed.push(stage.name);
      stageCosts.push({ name: stage.name, resumed: true, wallMs: 0, turns: 0, tokensIn: 0, tokensOut: 0, cacheHits: 0 });
      await emitJlcpcbAfterOutputs(stage.name, opts);
      continue;
    }
    const stageTurns = config.stageMaxTurns?.[stage.name];
    const basePrompt = stage.prompt(brief);
    let guidance = '';
    let stageDone = false;
    let stageTranscriptDir = '';
    const stageStart = Date.now();
    const cost: StageCost = { name: stage.name, resumed: false, wallMs: 0, turns: 0, tokensIn: 0, tokensOut: 0, cacheHits: 0 };
    for (let attempt = 1; ; attempt++) {
      if (stage.name === 'schematic') {
        const rescaffolded = await bootstrapKicadProject(opts.repoRoot, brief);
        if (rescaffolded && attempt > 1) opts.log(`stage schematic: re-scaffolded empty KiCad project after rollback, wired into config`);
      }
      opts.log(`stage ${stage.name}: running${attempt > 1 ? ` (attempt ${attempt}/${config.maxStageRetries + 1})` : ''}`);
      const res = await runAgentLoop({
        repoRoot: opts.repoRoot,
        model: opts.model,
        request: `create pipeline stage: ${stage.name}`,
        stagePrompt: guidance
          ? `${basePrompt}\n\n## Recovery guidance (a previous attempt did not complete this stage — do this differently)\n${guidance}`
          : basePrompt,
        interactive: opts.interactive ?? false,
        allowDirty: true,
        ...(stageTurns !== undefined ? { maxTurns: stageTurns } : {}),
        ...(opts.onBudgetExhausted ? { onBudgetExhausted: opts.onBudgetExhausted } : {}),
        log: opts.log,
        ...(opts.renderer ? { renderer: opts.renderer } : {}),
        meta: {
          ...opts.meta,
          command: 'create',
          stage: { name: stage.name, index: i + 1, total: STAGES.length },
          brief: briefMeta,
        },
      });

      cost.turns += res.stats?.turnsUsed ?? 0;
      cost.tokensIn += res.stats?.tokensIn ?? 0;
      cost.tokensOut += res.stats?.tokensOut ?? 0;
      cost.cacheHits += res.cacheHits ?? 0;
      stageTranscriptDir = res.transcriptDir;

      const failure =
        res.outcome !== 'success'
          ? `the run ended as "${res.outcome}" (${res.exitPath})`
          : !(await stage.isComplete(opts.repoRoot, config.docs))
            ? 'the run finished but the stage completion contract is not met — no usable artifact was produced'
            : null;
      if (!failure) {
        stageDone = true;
        break;
      }

      if (attempt > config.maxStageRetries) {
        opts.log(
          `stage ${stage.name}: ${failure}; exhausted ${config.maxStageRetries} auto-retry(ies). Stopping for a human.`,
        );
        break;
      }

      opts.log(`stage ${stage.name}: ${failure}; asking the model whether to retry…`);
      const diagnosis = await diagnose({
        model: opts.model,
        timeoutMs: config.turnTimeoutMs,
        stageName: stage.name,
        stageGoal: basePrompt,
        failure,
        transcriptDir: res.transcriptDir,
        attempt,
        maxAttempts: config.maxStageRetries + 1,
      });
      cost.tokensIn += diagnosis.usage?.inputTokens ?? 0;
      cost.tokensOut += diagnosis.usage?.outputTokens ?? 0;
      opts.log(`stage ${stage.name}: diagnosis → ${diagnosis.verdict} — ${diagnosis.reason}`);
      if (diagnosis.verdict === 'abort') {
        opts.log(`stage ${stage.name}: recovery supervisor recommends stopping for a human.`);
        break;
      }
      guidance = diagnosis.guidance ?? `The previous attempt failed: ${failure}. ${diagnosis.reason}`;
    }

    cost.wallMs = Date.now() - stageStart;
    stageCosts.push(cost);

    if (!stageDone) {
      logResumePoint(opts, stage, i);
      printCostTable(opts, stageCosts);
      await writeRunReport(opts, stageCosts);
      return { ok: false, completed };
    }
    completed.push(stage.name);
    await renderStageArtifacts(opts, stage.name, stageTranscriptDir);
    await emitJlcpcbAfterOutputs(stage.name, opts);
    logCumulative(opts, stageCosts);
  }

  const check = await runCheck(opts.repoRoot, opts.log);
  opts.log(check.ok ? 'create pipeline complete; all checks green' : 'create pipeline complete with check failures');
  printCostTable(opts, stageCosts);
  await writeRunReport(opts, stageCosts);
  return { ok: check.ok, completed };
}