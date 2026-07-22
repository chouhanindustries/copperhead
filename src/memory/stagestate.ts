import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Pipeline memory for `create` (change rerun-create-stages, design D1–D4):
 * the artifact vocabulary, content hashing, stage completion records in
 * .copperhead/create-state.json, and staleness classification. The stage
 * table itself (what consumes/produces what) lives in commands/create.ts;
 * this module owns the mechanics so they stay unit-testable without a run.
 */

/** Closed artifact vocabulary — edges of the stage graph name these (design D1). */
export type ArtifactName =
  | 'brief'
  | 'spec'
  | 'subsystems'
  | 'bom'
  | 'pinout'
  | 'schematic'
  | 'board'
  | 'layout-intent'
  | 'outputs'
  | 'firmware'
  | 'devplan';

/**
 * Hash sentinel for an artifact whose files do not exist. A real sha256 hex
 * digest can never equal this, so appearance/disappearance always registers
 * as a change (design D2).
 */
export const ABSENT = 'absent';

interface ArtifactConfigLike {
  schematic: string | null;
  board: string | null;
  docs: string;
}

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

/** Never part of a design artifact; walking .git would also make a repo-root schematic pathological. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.copperhead']);

/**
 * Every file under dir, recursively, as absolute paths (sorted for
 * determinism). No symlink-cycle guard is needed: Dirent.isDirectory() is
 * false for symlinks, so a linked directory degrades to a skipped entry —
 * do not "fix" this with stat(), which would follow the link and can loop.
 */
async function walkFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...(await walkFiles(abs)));
    } else {
      out.push(abs);
    }
  }
  return out.sort();
}

/** Files under dir (recursively) whose name matches, sorted. */
async function walkMatching(dir: string, test: (name: string) => boolean): Promise<string[]> {
  return (await walkFiles(dir)).filter((f) => test(path.basename(f)));
}

/**
 * The concrete file set an artifact name resolves to, given the repo config.
 * `schematic` covers every .kicad_sch under the configured schematic's
 * directory: hierarchical sheets are separate files and must count (design D1).
 */
export async function resolveArtifactFiles(
  name: ArtifactName,
  repoRoot: string,
  config: ArtifactConfigLike,
  briefPath?: string,
): Promise<string[]> {
  const doc = (file: string): string[] => [path.join(repoRoot, config.docs, file)];
  switch (name) {
    case 'brief':
      return briefPath ? [path.resolve(briefPath)] : [];
    case 'spec':
      return [...doc('SPEC.md'), path.join(repoRoot, '.copperhead', 'constraints.json')];
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
      if (!config.schematic) return [];
      // KiCad drops _autosave-*.kicad_sch next to open sheets; a run that
      // coincides with an open editor must not read as a schematic change.
      return walkMatching(
        path.dirname(path.join(repoRoot, config.schematic)),
        (n) => n.endsWith('.kicad_sch') && !n.startsWith('_autosave'),
      );
    case 'board':
      return config.board ? [path.join(repoRoot, config.board)] : [];
    case 'outputs':
      return walkFiles(path.join(repoRoot, 'outputs'));
    case 'firmware':
      return walkFiles(path.join(repoRoot, 'firmware'));
  }
}

async function fileHash(abs: string): Promise<string> {
  try {
    return sha256(await readFile(abs));
  } catch {
    return ABSENT;
  }
}

/**
 * Artifacts whose file set is discovered by walking a directory. Their hashes
 * must stay path-sensitive even with a single file, or renaming the sole file
 * (same bytes) would escape staleness. Fixed-path artifacts take the bare
 * content hash instead — their paths are constants, and for `brief` (which may
 * live outside the repo) a repo-relative path would vary by checkout location.
 */
const WALKED: ReadonlySet<ArtifactName> = new Set(['schematic', 'outputs', 'firmware']);

/**
 * Content hash of an artifact: sha256 per file; multi-file artifacts hash the
 * sorted (relative path, file hash) list so ordering can never matter; only
 * content participates, never timestamps (design D2).
 */
export async function hashArtifact(
  name: ArtifactName,
  repoRoot: string,
  config: ArtifactConfigLike,
  briefPath?: string,
): Promise<string> {
  const files = await resolveArtifactFiles(name, repoRoot, config, briefPath);
  if (!files.length) return ABSENT;
  const pairs = await Promise.all(
    files.map(async (f) => `${path.relative(repoRoot, f)}\n${await fileHash(f)}`),
  );
  if (pairs.every((p) => p.endsWith(`\n${ABSENT}`))) return ABSENT;
  if (!WALKED.has(name) && pairs.length === 1) return pairs[0]!.split('\n')[1]!;
  return sha256(pairs.sort().join('\n'));
}

/** One stage's completion record, written inside the stage's own commit (design D3). */
export interface StageRecord {
  completedAt: string;
  runId: string;
  /** Hashes of consumed artifacts as read at stage start. */
  inputs: Partial<Record<ArtifactName, string>>;
  /** Hashes of produced artifacts as read at commit time. */
  outputs: Partial<Record<ArtifactName, string>>;
}

export interface CreateState {
  version: 1;
  stages: Record<string, StageRecord>;
}

export function createStatePath(repoRoot: string): string {
  return path.join(repoRoot, '.copperhead', 'create-state.json');
}

const emptyState = (): CreateState => ({ version: 1, stages: {} });

/** A record missing any field would crash classification; validate per record, not just the envelope. */
function isValidRecord(rec: unknown): rec is StageRecord {
  if (typeof rec !== 'object' || rec === null) return false;
  const r = rec as Partial<StageRecord>;
  const isMap = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);
  return typeof r.completedAt === 'string' && typeof r.runId === 'string' && isMap(r.inputs) && isMap(r.outputs);
}

/**
 * A missing, corrupt, unparseable, or wrong-version state file degrades to
 * "no records" with a warning, and an individually malformed record (hand
 * edit, partial write) degrades to "unrecorded" for that stage only — the
 * completion probes then decide — never an abort (AC-9.8).
 */
export async function loadCreateState(
  repoRoot: string,
): Promise<{ state: CreateState; warning: string | null }> {
  const p = createStatePath(repoRoot);
  if (!existsSync(p)) return { state: emptyState(), warning: null };
  try {
    const raw = JSON.parse(await readFile(p, 'utf8')) as Partial<CreateState>;
    if (
      typeof raw !== 'object' ||
      raw === null ||
      typeof raw.stages !== 'object' ||
      raw.stages === null ||
      Array.isArray(raw.stages)
    ) {
      throw new Error('missing stages map');
    }
    if (raw.version !== 1) {
      throw new Error(`unsupported version ${JSON.stringify(raw.version ?? null)}`);
    }
    const stages: CreateState['stages'] = {};
    const dropped: string[] = [];
    for (const [name, rec] of Object.entries(raw.stages as Record<string, unknown>)) {
      if (isValidRecord(rec)) stages[name] = rec;
      else dropped.push(name);
    }
    return {
      state: { version: 1, stages },
      warning: dropped.length
        ? `dropped malformed completion record(s) in ${path.relative(repoRoot, p)} for: ${dropped.join(', ')} (treated as unrecorded)`
        : null,
    };
  } catch (err) {
    return {
      state: emptyState(),
      warning: `could not read ${path.relative(repoRoot, p)} (${(err as Error).message}); treating all stages as unrecorded`,
    };
  }
}

export async function saveStageRecord(repoRoot: string, stage: string, record: StageRecord): Promise<void> {
  const { state, warning } = await loadCreateState(repoRoot);
  const p = createStatePath(repoRoot);
  // A corrupt file degrades to an empty state on load; writing that back with
  // only this record would silently erase every other stage's history. Keep
  // the unreadable original beside the fresh file instead.
  if (warning && existsSync(p)) {
    try {
      await rename(p, `${p}.corrupt`);
    } catch {
      // best effort: the fresh state below is still the right thing to write
    }
  }
  state.stages[stage] = record;
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/**
 * Stage classification (design D4). `assumed-complete` = no record but the
 * contract probe passes (repos built before completion records existed);
 * such stages are never auto-re-run on hash grounds — there is nothing to
 * compare against.
 */
export type StageStatus = 'fresh' | 'stale' | 'incomplete' | 'assumed-complete';

export interface StageClassification {
  stage: string;
  status: StageStatus;
  /** Consumed artifacts whose recorded hash no longer matches (stale only). */
  changedInputs: ArtifactName[];
}

export interface ClassifiableStage {
  name: string;
  consumes: ArtifactName[];
  isComplete: () => Promise<boolean> | boolean;
}

export async function classifyStages(opts: {
  repoRoot: string;
  config: ArtifactConfigLike;
  briefPath?: string;
  stages: ClassifiableStage[];
}): Promise<{ classifications: StageClassification[]; warning: string | null }> {
  const { state, warning } = await loadCreateState(opts.repoRoot);
  const classifications: StageClassification[] = [];
  for (const stage of opts.stages) {
    const record = state.stages[stage.name];
    if (!record) {
      classifications.push({
        stage: stage.name,
        status: (await stage.isComplete()) ? 'assumed-complete' : 'incomplete',
        changedInputs: [],
      });
      continue;
    }
    const changedInputs: ArtifactName[] = [];
    for (const artifact of stage.consumes) {
      const current = await hashArtifact(artifact, opts.repoRoot, opts.config, opts.briefPath);
      // A consumed artifact with no recorded hash (the consumes set grew since
      // the record was written) counts as changed: there is no basis to call
      // the stage fresh with respect to it.
      if (record.inputs[artifact] !== current) changedInputs.push(artifact);
    }
    // Changed inputs outrank a failing probe: drift-aware probes (the
    // schematic stage's, since the create-pipeline hardening) fail *because*
    // an upstream artifact changed, and demoting to incomplete there would
    // lose the stale trigger, the changed-input names, and the reconciliation
    // preamble in exactly the flagship case. Only a recorded stage whose
    // inputs still match and whose probe fails now — its work product was
    // deleted, or the probes have grown stricter since the record was
    // written — runs from scratch as incomplete (AC-9.9).
    if (changedInputs.length) {
      classifications.push({ stage: stage.name, status: 'stale', changedInputs });
      continue;
    }
    if (!(await stage.isComplete())) {
      classifications.push({ stage: stage.name, status: 'incomplete', changedInputs: [] });
      continue;
    }
    classifications.push({ stage: stage.name, status: 'fresh', changedInputs: [] });
  }
  return { classifications, warning };
}
