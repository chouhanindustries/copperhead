import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadConfig, type CopperheadConfig } from '../config.js';
import { isDirty } from '../util/git.js';
import { runAgentLoop } from '../agent/loop.js';
import type { Provider } from '../agent/types.js';
import type { RunMetaInput, StageTrigger } from '../agent/runmeta.js';
import type { ProgressRenderer } from '../agent/render.js';
import { openspecInit } from '../openspec/cli.js';
import { runCheck } from './check.js';
import {
  classifyStages,
  hashArtifact,
  saveStageRecord,
  type ArtifactName,
  type StageClassification,
} from '../memory/stagestate.js';

/**
 * Mode A (`copperhead create`, SPEC §2.5): staged pipeline, each stage a
 * do-loop run with a stage prompt and gate. Stage completion is tracked
 * record-first — content hashes of each stage's inputs/outputs land in
 * .copperhead/create-state.json inside the stage's own commit — with the
 * repo-state probes as fallback for unrecorded stages (change
 * rerun-create-stages; the probe bodies belong to #23/PR #29 and are not
 * touched here). Run-to-completion: gates are quality checks the agent must
 * satisfy, not stops that wait for a human (unless --interactive).
 */
interface Stage {
  name: string;
  /** Artifacts this stage reads — the incoming edges of the stage graph. */
  consumes: ArtifactName[];
  /** Artifacts this stage writes — the outgoing edges of the stage graph. */
  produces: ArtifactName[];
  /** Fallback probe when no completion record exists (resume support). */
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
    consumes: ['brief'],
    produces: ['spec'],
    isComplete: (root, docs) => docHasContent(root, path.join(docs, 'SPEC.md'), '## Budgets'),
    prompt: (brief) =>
      `Stage 1 of the create pipeline: seed the requirements. From the product brief below, write docs/SPEC.md (what the device is, top-level constraints and budgets). Every budget you state must also be recorded with record_constraint. Anything the brief does not state: propose a sensible default and flag it ASSUMED. If an openspec/ workspace exists, also seed openspec/specs/ with per-capability requirements using Given/When/Then scenarios.\n\nBrief:\n${brief}`,
  },
  {
    name: 'architecture',
    consumes: ['spec'],
    produces: ['subsystems'],
    isComplete: (root, docs) => docExists(root, path.join(docs, 'SUBSYSTEMS.md')),
    prompt: () =>
      'Stage 2: architecture. Write docs/SUBSYSTEMS.md: the block diagram in prose, one section per subsystem (power, MCU, connectivity, UI, ...), with the reasoning and key values for each. Respect every budget in SPEC.md.',
  },
  {
    name: 'part-selection',
    consumes: ['spec', 'subsystems'],
    produces: ['bom'],
    isComplete: (root, docs) => docExists(root, path.join(docs, 'BOM.md')),
    prompt: () =>
      'Stage 3: part selection. Write docs/BOM.md with the fixed table format (| Refdes | Value | Footprint | MPN | Rationale |). Every MPN you introduce is flagged UNVERIFIED with a datasheet-verifiable justification. Check leakage/quiescent current of every part against the power budget. Run check_drift before finishing.',
  },
  {
    name: 'schematic',
    consumes: ['bom', 'subsystems'],
    produces: ['schematic', 'pinout'],
    isComplete: async (root) => {
      const config = await loadConfig(root);
      return !!config.schematic && existsSync(path.join(root, config.schematic));
    },
    prompt: () =>
      'Stage 4: schematic. Build the schematic sheet by sheet from BOM.md and SUBSYSTEMS.md. After each sheet, run run_erc and fix violations before moving on. Same net names and refdes everywhere. Update PINOUT.md as you assign pins; check the strapping table first.',
  },
  {
    name: 'layout-draft',
    consumes: ['schematic'],
    produces: ['board', 'layout-intent'],
    isComplete: (root, docs) => docHasContent(root, path.join(docs, 'LAYOUT.md'), '## Draft quality'),
    prompt: () =>
      'Stage 5: first-draft layout. Rule-driven placement written as real coordinates: connectors on edges, decoupling at IC pins, ESD at connectors, keepouts honored. Route power and short critical nets; leave the rest as ratsnest. Every routed net must pass run_drc. Then write the "## Draft quality" section in LAYOUT.md: exactly what is fine and what a human or specialist tool should redo. Non-optimal is acceptable; unlabeled non-optimal is not.',
  },
  {
    name: 'outputs',
    consumes: ['board', 'bom'],
    produces: ['outputs'],
    isComplete: (root) => existsSync(path.join(root, 'outputs')),
    prompt: () =>
      'Stage 6: outputs package. Export into outputs/: gerbers+drill (JLC profile), DXF and STEP outline, SVG renders (export_svg), and an ordering BOM.csv generated from BOM.md (refdes, MPN, qty). Every export must succeed.',
  },
  {
    name: 'firmware',
    consumes: ['pinout'],
    produces: ['firmware'],
    isComplete: (root) => existsSync(path.join(root, 'firmware')),
    prompt: () =>
      'Stage 7: firmware scaffold. Generate firmware/ for the chosen MCU HAL: pins.h generated from PINOUT.md (single source of truth), driver stubs, and one working happy path. If the vendor toolchain is available, the build must pass; if not, note "not compiled here" explicitly in DEVPLAN.md.',
  },
  {
    name: 'devplan',
    consumes: ['schematic', 'firmware', 'layout-intent'],
    produces: ['devplan'],
    isComplete: (root, docs) => docExists(root, path.join(docs, 'DEVPLAN.md')),
    prompt: () =>
      'Stage 8: DEVPLAN.md. Write docs/DEVPLAN.md: bring-up steps in order, test points and what to meter first, risk list, and the prototype order plan.',
  },
];

export const stageNames = (): string[] => STAGES.map((s) => s.name);

const stageIndex = (name: string): number => STAGES.findIndex((s) => s.name === name);

/**
 * Stages reachable from `name` via produces→consumes edges. A single forward
 * pass suffices because the STAGES array is a topological order of the graph
 * (asserted by test); the result is what `--from` re-runs.
 */
export function descendantsOf(name: string): string[] {
  const start = stageIndex(name);
  if (start === -1) return [];
  const reachable = new Set<ArtifactName>(STAGES[start]!.produces);
  const out: string[] = [];
  for (const s of STAGES.slice(start + 1)) {
    if (s.consumes.some((a) => reachable.has(a))) {
      out.push(s.name);
      for (const a of s.produces) reachable.add(a);
    }
  }
  return out;
}

/** Where an artifact lives, for the reconciliation preamble (design D6: name and path). */
function artifactLocation(a: ArtifactName, config: CopperheadConfig): string {
  const doc = (f: string): string => path.join(config.docs, f);
  switch (a) {
    case 'brief':
      return 'the product brief file';
    case 'spec':
      return `${doc('SPEC.md')} and .copperhead/constraints.json`;
    case 'subsystems':
      return doc('SUBSYSTEMS.md');
    case 'bom':
      return doc('BOM.md');
    case 'pinout':
      return doc('PINOUT.md');
    case 'layout-intent':
      return doc('LAYOUT.md');
    case 'devplan':
      return doc('DEVPLAN.md');
    case 'schematic':
      return config.schematic ?? 'the .kicad_sch files';
    case 'board':
      return config.board ?? 'the .kicad_pcb';
    case 'outputs':
      return 'outputs/';
    case 'firmware':
      return 'firmware/';
  }
}

function reconciliationPreamble(changed: ArtifactName[], config: CopperheadConfig): string {
  return [
    'This stage completed previously, but upstream artifacts it depends on have changed since:',
    ...changed.map((a) => `- ${a} (${artifactLocation(a, config)})`),
    'Revise the existing artifacts of this stage to reconcile with those changes; do not recreate them from scratch.',
    'Read the changed files and use check_drift to find the exact disagreements. Where an item needs no change, say why in one line and move on.',
  ].join('\n');
}

const REVISION_PREAMBLE =
  'This stage completed previously and is being deliberately re-run. Revise its existing artifacts in place with anchored edits; do not recreate them.';

export interface CreateOptions {
  repoRoot: string;
  briefPath: string;
  model: string;
  interactive?: boolean;
  /** Re-run exactly this stage, then propagate to consumers of changed outputs. */
  stage?: string;
  /** Force-re-run this stage and its graph descendants. */
  from?: string;
  /** Print stage classification and the would-run set; write nothing. */
  dryRun?: boolean;
  confirm?: (question: string) => Promise<boolean>;
  log: (s: string) => void;
  renderer?: ProgressRenderer;
  /** Command-level metadata; stage and brief identity are filled in per stage. */
  meta?: Omit<RunMetaInput, 'stage' | 'brief'>;
  /** Test seam: forwarded to every stage's agent-loop run. */
  provider?: Provider;
}

const classificationLine = (c: StageClassification): string =>
  `  ${c.stage}: ${c.status}${c.changedInputs.length ? ` (changed: ${c.changedInputs.join(', ')})` : ''}`;

/** Throws with the valid-name listing; exported so the CLI can fail fast, before model/kicad resolution (AC-9.6). */
export function validateStageFlags(stage?: string, from?: string): void {
  for (const [flag, value] of [
    ['--stage', stage],
    ['--from', from],
  ] as const) {
    if (value && stageIndex(value) === -1) {
      throw new Error(`unknown stage "${value}" for ${flag}; valid stages: ${stageNames().join(', ')}`);
    }
  }
  if (stage && from) {
    throw new Error('--stage and --from are mutually exclusive: --stage re-runs one stage and propagates real changes; --from force-re-runs a stage and its descendants');
  }
}

export async function runCreate(opts: CreateOptions): Promise<{ ok: boolean; completed: string[] }> {
  validateStageFlags(opts.stage, opts.from);

  const brief = await readFile(path.resolve(opts.briefPath), 'utf8');
  // Hashed from the content already in hand: a brief edited mid-pipeline shows
  // up as a different sha256 in the next stage's metadata (AC-8.1).
  const briefMeta = { path: opts.briefPath, sha256: createHash('sha256').update(brief).digest('hex') };
  const confirm = opts.confirm ?? (async () => true);

  // Classification always reads a fresh config: earlier stages set
  // schematic/board paths in .copperhead/config.json as they create them.
  const classify = async (): Promise<{ classifications: StageClassification[]; warning: string | null }> => {
    const config = await loadConfig(opts.repoRoot);
    return classifyStages({
      repoRoot: opts.repoRoot,
      config,
      briefPath: opts.briefPath,
      stages: STAGES.map((s) => ({
        name: s.name,
        consumes: s.consumes,
        isComplete: () => s.isComplete(opts.repoRoot, config.docs),
      })),
    });
  };

  const initial = await classify();
  if (initial.warning) opts.log(`warning: ${initial.warning}`);
  const statusOf = new Map(initial.classifications.map((c) => [c.stage, c]));

  const mode = opts.stage ? `--stage ${opts.stage}` : opts.from ? `--from ${opts.from}` : 'default';
  let planned: string[];
  if (opts.stage) planned = [opts.stage];
  else if (opts.from) planned = [opts.from, ...descendantsOf(opts.from)];
  else
    planned = initial.classifications
      .filter((c) => c.status === 'incomplete' || c.status === 'stale')
      .map((c) => c.stage);
  const plannedInitially = new Set(planned);

  if (opts.dryRun) {
    opts.log('stage classification:');
    for (const c of initial.classifications) opts.log(classificationLine(c));
    opts.log(
      planned.length
        ? `would run (${mode}): ${planned.join(' → ')}`
        : 'nothing to run: pipeline is consistent',
    );
    return { ok: true, completed: [] };
  }

  await openspecInit(opts.repoRoot);
  if (planned.length && (opts.stage || opts.from)) {
    opts.log(`plan (${mode}): ${planned.join(' → ')}`);
    // Stage commits use git add -A, so on a mature repo a targeted re-run
    // would silently sweep unrelated WIP into the stage's commit.
    if (await isDirty(opts.repoRoot)) {
      opts.log('warning: working tree is dirty; uncommitted changes will be included in the re-run stage commit(s)');
    }
  }

  const completed: string[] = [];
  if (!opts.stage && !opts.from) {
    for (const c of initial.classifications) {
      if (c.status === 'fresh') opts.log(`stage ${c.stage}: fresh (skipping)`);
      else if (c.status === 'assumed-complete') opts.log(`stage ${c.stage}: already complete (resuming past it)`);
      else continue;
      completed.push(c.stage);
    }
  }

  const queue = [...planned];
  const ran = new Set<string>();
  /** Artifacts actually changed by stages run in this invocation. */
  const changedThisRun = new Set<ArtifactName>();

  while (queue.length) {
    queue.sort((a, b) => stageIndex(a) - stageIndex(b));
    const name = queue.shift()!;
    const stage = STAGES[stageIndex(name)]!;
    const cls = statusOf.get(name)!;
    const forced = opts.stage === name || (opts.from !== undefined && plannedInitially.has(name));
    // A queued stale stage can turn fresh before it pops (an earlier stage's
    // run restored its inputs); running it anyway would burn a full LLM stage
    // run on nothing and mislabel the trigger.
    if (!forced && cls.status === 'fresh') {
      opts.log(`stage ${name}: became fresh before running (inputs restored by an earlier stage); skipping`);
      completed.push(name);
      continue;
    }
    const trigger: StageTrigger =
      opts.stage === name
        ? 'requested'
        : opts.from && plannedInitially.has(name)
          ? 'from'
          : cls.status === 'stale'
            ? 'stale'
            : 'initial';

    let config = await loadConfig(opts.repoRoot);
    const inputs: Partial<Record<ArtifactName, string>> = {};
    for (const a of stage.consumes) inputs[a] = await hashArtifact(a, opts.repoRoot, config, opts.briefPath);
    const preOutputs: Partial<Record<ArtifactName, string>> = {};
    for (const a of stage.produces) preOutputs[a] = await hashArtifact(a, opts.repoRoot, config, opts.briefPath);

    let stagePrompt = stage.prompt(brief);
    if (trigger === 'stale') stagePrompt = `${reconciliationPreamble(cls.changedInputs, config)}\n\n${stagePrompt}`;
    else if (cls.status !== 'incomplete') stagePrompt = `${REVISION_PREAMBLE}\n\n${stagePrompt}`;

    const rerunNote =
      trigger === 'initial' ? '' : ` (${trigger}${cls.changedInputs.length ? `: ${cls.changedInputs.join(', ')}` : ''})`;
    opts.log(`stage ${name}: running${rerunNote}`);

    let recordWithheld = false;
    const res = await runAgentLoop({
      repoRoot: opts.repoRoot,
      model: opts.model,
      request: `create pipeline stage: ${name}`,
      stagePrompt,
      interactive: opts.interactive ?? false,
      allowDirty: true, // stages build on each other's uncommitted state within the pipeline
      log: opts.log,
      ...(opts.confirm ? { confirm: opts.confirm } : {}),
      ...(opts.renderer ? { renderer: opts.renderer } : {}),
      ...(opts.provider ? { provider: opts.provider } : {}),
      // The completion record must ride the stage's own commit (design D3).
      beforeCommit: async ({ runId }) => {
        const cfgNow = await loadConfig(opts.repoRoot);
        // The record asserts "this stage's work exists as committed". A run
        // can pass the loop gates without producing its artifacts (or without
        // meeting a stricter completion contract); recording it would make
        // absent work permanently "fresh". Withhold the record instead — the
        // commit still lands, and the next create re-runs the stage.
        if (!(await stage.isComplete(opts.repoRoot, cfgNow.docs))) {
          recordWithheld = true;
          return;
        }
        const outputs: Partial<Record<ArtifactName, string>> = {};
        for (const a of stage.produces) outputs[a] = await hashArtifact(a, opts.repoRoot, cfgNow, opts.briefPath);
        await saveStageRecord(opts.repoRoot, name, {
          completedAt: new Date().toISOString(),
          runId,
          inputs,
          outputs,
        });
      },
      meta: {
        ...opts.meta,
        command: 'create',
        stage: {
          name,
          index: stageIndex(name) + 1,
          total: STAGES.length,
          trigger,
          ...(cls.changedInputs.length ? { changedInputs: cls.changedInputs } : {}),
        },
        brief: briefMeta,
      },
    });
    if (res.outcome !== 'success') {
      opts.log(`stage ${name} did not complete (${res.outcome}); re-run copperhead create to resume here`);
      return { ok: false, completed };
    }
    if (recordWithheld) {
      opts.log(
        `stage ${name}: committed, but its completion contract is not met; no completion record written — the stage will run again on the next create`,
      );
    }
    ran.add(name);
    completed.push(name);

    // Propagation: only outputs that actually changed invalidate consumers.
    config = await loadConfig(opts.repoRoot);
    const changed: ArtifactName[] = [];
    for (const a of stage.produces) {
      if ((await hashArtifact(a, opts.repoRoot, config, opts.briefPath)) !== preOutputs[a]) changed.push(a);
    }
    if (!changed.length) {
      opts.log(`stage ${name}: outputs unchanged; nothing invalidated`);
      continue;
    }
    for (const a of changed) changedThisRun.add(a);

    const re = await classify();
    // The state file can go bad mid-invocation too; a silent degradation here
    // would let recorded stages reclassify by probe with no visible signal.
    if (re.warning) opts.log(`warning: ${re.warning}`);
    for (const c of re.classifications) statusOf.set(c.stage, c);
    // Newly stale = stale because of what THIS invocation changed. Staleness
    // that predates the run stays where the mode put it: the default mode
    // already queued it, and a targeted mode must not silently widen itself.
    const newlyStale = re.classifications.filter(
      (c) =>
        c.status === 'stale' &&
        !ran.has(c.stage) &&
        !queue.includes(c.stage) &&
        c.changedInputs.some((a) => changedThisRun.has(a)),
    );
    if (!newlyStale.length) continue;
    opts.log(
      `stale after ${name}: ${newlyStale.map((c) => `${c.stage} (${c.changedInputs.join(', ')} edge)`).join(', ')}`,
    );
    if (opts.interactive) {
      const approved = await confirm(
        `Reconcile stale stage(s) ${newlyStale.map((c) => c.stage).join(', ')} now?`,
      );
      if (!approved) {
        opts.log('stale stages left unreconciled; a later `copperhead create` run will pick them up');
        continue;
      }
    }
    queue.push(...newlyStale.map((c) => c.stage));
  }

  const check = await runCheck(opts.repoRoot, opts.log);
  opts.log(check.ok ? 'create pipeline complete; all checks green' : 'create pipeline complete with check failures');
  return { ok: check.ok, completed };
}
