import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadConfig } from '../config.js';
import { listSymbols } from '../kicad/sexp.js';
import { checkDrift } from '../memory/drift.js';
import { runAgentLoop, type BudgetExhaustedStats } from '../agent/loop.js';
import type { RunMetaInput } from '../agent/runmeta.js';
import type { ProgressRenderer } from '../agent/render.js';
import { openspecInit } from '../openspec/cli.js';
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

export const STAGES: Stage[] = [
  {
    name: 'spec-seed',
    isComplete: (root, docs) => docHasContent(root, path.join(docs, 'SPEC.md'), '## Budgets'),
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
      // Mere file existence is not completion: bootstrapping leaves a blank
      // sheet on disk (a hand-scaffolded project, or the future fix for #19),
      // and skipping this stage over a blank sheet cascades — layout and
      // outputs then run against nothing. The stage's contract is "build the
      // schematic from BOM.md", so completion means symbols exist AND the
      // BOM/PINOUT tables agree with them (drift-clean); anything less keeps
      // the stage active on the next resume so partial capture continues.
      if (!(await listSymbols(p)).length) return false;
      return (await checkDrift(root, config.docs, config.schematic)).length === 0;
    },
    prompt: () =>
      'Stage 4: schematic. Build the schematic sheet by sheet from BOM.md and SUBSYSTEMS.md. After each sheet, run run_erc and fix violations before moving on. Same net names and refdes everywhere. Update PINOUT.md as you assign pins; check the strapping table first.',
  },
  {
    name: 'layout-draft',
    isComplete: async (root, docs) => {
      // The LAYOUT.md marker alone is not enough: `copperhead init` scaffolds
      // LAYOUT.md with the literal "## Draft quality" heading, so an init-ed
      // repo would skip this stage without a single footprint placed. Require
      // a board with at least one footprint on it as well.
      const config = await loadConfig(root);
      if (!config.board) return false;
      const p = path.join(root, config.board);
      if (!existsSync(p)) return false;
      if (!(await readFile(p, 'utf8')).includes('(footprint')) return false;
      return docHasContent(root, path.join(docs, 'LAYOUT.md'), '## Draft quality');
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
  /** Forwarded to each stage's run (attended continue-on-exhaustion prompt). */
  onBudgetExhausted?: (stats: BudgetExhaustedStats) => Promise<number>;
  log: (s: string) => void;
  renderer?: ProgressRenderer;
  /** Command-level metadata; stage and brief identity are filled in per stage. */
  meta?: Omit<RunMetaInput, 'stage' | 'brief'>;
}

/**
 * Stage 6 emits the JLCPCB assembly BOM deterministically alongside the agent's
 * outputs package (create-pipeline delta). Called whenever the outputs stage is
 * confirmed complete — on the pass that finishes it and on any later resume — so
 * the file tracks the current BOM.md.
 */
async function emitJlcpcbAfterOutputs(stageName: string, opts: CreateOptions): Promise<void> {
  if (stageName !== 'outputs') return;
  const out = await emitCreateJlcpcbBom(opts.repoRoot);
  if (out) opts.log(`stage outputs: emitted ${out} (JLCPCB assembly BOM)`);
}

export async function runCreate(opts: CreateOptions): Promise<{ ok: boolean; completed: string[] }> {
  const brief = await readFile(path.resolve(opts.briefPath), 'utf8');
  // Hashed from the content already in hand: a brief edited mid-pipeline shows
  // up as a different sha256 in the next stage's metadata (AC-8.1).
  const briefMeta = { path: opts.briefPath, sha256: createHash('sha256').update(brief).digest('hex') };
  const config = await loadConfig(opts.repoRoot);
  await openspecInit(opts.repoRoot);
  const completed: string[] = [];

  for (const [i, stage] of STAGES.entries()) {
    if (await stage.isComplete(opts.repoRoot, config.docs)) {
      opts.log(`stage ${stage.name}: already complete (resuming past it)`);
      completed.push(stage.name);
      await emitJlcpcbAfterOutputs(stage.name, opts);
      continue;
    }
    opts.log(`stage ${stage.name}: running`);
    const stageTurns = config.stageMaxTurns?.[stage.name];
    const res = await runAgentLoop({
      repoRoot: opts.repoRoot,
      model: opts.model,
      request: `create pipeline stage: ${stage.name}`,
      stagePrompt: stage.prompt(brief),
      interactive: opts.interactive ?? false,
      allowDirty: true, // stages build on each other's uncommitted state within the pipeline
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
    if (res.outcome !== 'success') {
      opts.log(`stage ${stage.name} did not complete (${res.outcome}); re-run copperhead create to resume here`);
      return { ok: false, completed };
    }
    // A successful run is not the same as a completed stage: an agent can
    // finish "done" with all gates green having only planned the work (seen
    // with the schematic stage: one header edit, ERC "clean" on an empty
    // sheet). Advancing anyway lets every later stage run against a design
    // that isn't there, so hold the pipeline until this stage's repo-state
    // contract is actually met.
    if (!(await stage.isComplete(opts.repoRoot, config.docs))) {
      opts.log(
        `stage ${stage.name}: run succeeded but the stage contract is not met yet (partial work committed); re-run copperhead create to continue this stage`,
      );
      return { ok: false, completed };
    }
    completed.push(stage.name);
    await emitJlcpcbAfterOutputs(stage.name, opts);
  }

  const check = await runCheck(opts.repoRoot, opts.log);
  opts.log(check.ok ? 'create pipeline complete; all checks green' : 'create pipeline complete with check failures');
  return { ok: check.ok, completed };
}
