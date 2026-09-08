import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { runCreate, STAGES } from '../src/commands/create.js';
import { runCheck } from '../src/commands/check.js';
import { loadConfig } from '../src/config.js';
import { runDrc, runErc, kicadCliVersion } from '../src/kicad/cli.js';
import { listSymbols } from '../src/kicad/sexp.js';
import { LLM_CACHE_ONLY_ENV } from '../src/agent/response-cache.js';

/**
 * This is deliberately an opt-in end-to-end test. A record invokes the real
 * configured provider and writes a fixture; a replay invokes the production
 * pipeline with the cache-only provider path. The normal test suite never
 * needs credentials, a provider CLI, KiCad, or a pre-recorded fixture.
 */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE_DIR = path.join(TEST_DIR, 'fixtures', 'create-pipeline-replay');
const BRIEF_SOURCE = path.resolve(TEST_DIR, '..', 'examples', 'simple', 'usb-c-breakout.md');
const BRIEF_BASENAME = 'usb-c-breakout.md';
const MODEL_ENV = 'COPPERHEAD_E2E_MODEL';
const RECORD_ENV = 'COPPERHEAD_E2E_RECORD';
const REPLAY_ENV = 'COPPERHEAD_E2E_REPLAY';
const FIXTURE_ENV = 'COPPERHEAD_E2E_FIXTURE_DIR';
const TIMEOUT_ENV = 'COPPERHEAD_E2E_TIMEOUT_MS';
const CHILD_ENV = 'COPPERHEAD_E2E_ISOLATED_CHILD';
const TMP_ROOT_ENV = 'COPPERHEAD_E2E_TMP_ROOT';
const CHILD_MODE_ENV = 'COPPERHEAD_E2E_CHILD_MODE';
const WATCHDOG_ENV = 'COPPERHEAD_E2E_WATCHDOG_TEST';

const recording = process.env[RECORD_ENV] === '1';
const replaying = process.env[REPLAY_ENV] === '1' || process.env[LLM_CACHE_ONLY_ENV] === '1';
const modeConflict = recording && replaying;
const mode: 'record' | 'replay' | null = recording ? 'record' : replaying ? 'replay' : null;

const configuredTimeout = Number(process.env[TIMEOUT_ENV]);
/**
 * Record runs are allowed to spend the time a real provider needs. Replay is
 * expected to be much quicker because it never starts a provider process.
 * A parent process enforces the deadline and terminates the child process
 * group; the child's Vitest timeout provides a second fail-fast bound.
 */
const E2E_TIMEOUT_MS = Number.isFinite(configuredTimeout) && configuredTimeout > 0
  ? configuredTimeout
  : mode === 'record'
    ? 2 * 60 * 60 * 1000
    : 15 * 60 * 1000;
const KILL_GRACE_MS = 2_000;
const CHILD_OUTPUT_LIMIT = 8_000;

type FileDigest = { path: string; bytes: number; sha256: string };

interface StageClock {
  name: string;
  at: string;
}

interface ToolingManifest {
  kicadCli: string | null;
  openspec: string | null;
}

interface ReplayManifest {
  schemaVersion: 1;
  model: string;
  brief: { file: string; sha256: string };
  config: { file: string; sha256: string };
  clock: { stages: StageClock[] };
  tooling: ToolingManifest;
  initialTree: { files: FileDigest[]; sha256: string };
  cache: { directory: string; count: number; files: FileDigest[]; sha256: string };
  finalTree: { files: FileDigest[]; sha256: string };
}

interface RepoHandle {
  repo: string;
  brief: string;
  cleanup: () => Promise<void>;
}

interface CapturedCreate {
  result: Awaited<ReturnType<typeof runCreate>>;
  logs: string[];
}

/** A fixed initial config keeps the cache key's pre-schematic state explicit. */
const INITIAL_CONFIG = JSON.stringify(
  {
    schematic: null,
    board: null,
    docs: 'docs/',
    model: null,
    maxTurns: 40,
    maxRepairCycles: 20,
    maxStageRetries: 0,
    llmCache: true,
  },
  null,
  2,
) + '\n';

const INITIAL_GITIGNORE = '.env\n.copperhead/runs/\n.copperhead/llm-cache/\n.history/\n';

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function digestRows(rows: FileDigest[]): string {
  return sha256(rows.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}\n`).join(''));
}

/**
 * KiCad's external exporters stamp wall-clock metadata into otherwise useful
 * output files. Keep the comparison content-sensitive by replacing only the
 * documented exporter metadata fields, never coordinates, nets, or geometry.
 * This is used only for the final tracked-tree comparison; the actual files
 * remain untouched in the temporary repository.
 */
function canonicalGeneratedArtifact(rel: string, data: Buffer): Buffer {
  const normalizedRel = rel.split(path.sep).join('/');
  if (!normalizedRel.startsWith('outputs/')) return data;
  const text = data.toString('utf8');
  // Binary output is not a KiCad text export. Text outputs are scanned by
  // exact metadata patterns so uncommon Gerber extensions stay covered.
  if (text.includes('\u0000') || text.includes('\ufffd')) return data;
  const canonical = text
    // KiCad's SVG exporter writes this title with the host clock. The rest of
    // the SVG, including all drawn paths and labels, remains byte-sensitive.
    .replace(
      /(<title>SVG Image created as [^<]*? date )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?(\s*<\/title>)/g,
      '$1<volatile-date>$2',
    )
    // Gerber X2 and Excellon metadata use a creation-date attribute/comment.
    .replace(/^([ \t]*G04 #@! TF\.CreationDate,)[^*\r\n]*(\*)$/gm, '$1<volatile-date>$2')
    .replace(/^([ \t]*%TF\.CreationDate,)[^*\r\n]*(\*%)$/gm, '$1<volatile-date>$2')
    .replace(/^([ \t]*G04 Created by KiCad \(.*\) date )[^*\r\n]*(\*)$/gm, '$1<volatile-date>$2')
    .replace(/^([ \t]*; #@! TF\.CreationDate,)[^\r\n]*$/gm, '$1<volatile-date>')
    .replace(/^([ \t]*; DRILL file (?:\{)?KiCad [^}\r\n]+(?:\})? date )[^\r\n]*$/gim, '$1<volatile-date>')
    // STEP's ISO-10303 header carries the generation timestamp in FILE_NAME.
    // Restrict the replacement to that header so a design string elsewhere is
    // never treated as metadata.
    .replace(
      /(^FILE_NAME\s*\([\s\S]*?\b'?)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?('?[\s\S]*?\);)/m,
      '$1<volatile-date>$2',
    );
  return canonical === text ? data : Buffer.from(canonical, 'utf8');
}

async function digestFile(root: string, rel: string, canonicalizeGenerated = false): Promise<FileDigest> {
  const data = await readFile(path.join(root, rel));
  const comparable = canonicalizeGenerated ? canonicalGeneratedArtifact(rel, data) : data;
  return { path: rel.split(path.sep).join('/'), bytes: comparable.byteLength, sha256: sha256(comparable) };
}

/** Hash tracked regular files only; optionally canonicalize exporter dates for final-tree comparison. */
async function trackedTree(repo: string, canonicalizeGenerated = false): Promise<{ files: FileDigest[]; sha256: string }> {
  const { stdout } = await execa('git', ['ls-files', '-z'], { cwd: repo });
  const files: FileDigest[] = [];
  for (const rel of stdout.split('\0').filter(Boolean)) {
    const entry = await stat(path.join(repo, rel));
    if (entry.isFile()) files.push(await digestFile(repo, rel, canonicalizeGenerated));
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, sha256: digestRows(files) };
}

async function regularFiles(root: string): Promise<FileDigest[]> {
  const files: FileDigest[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? path.join(prefix, entry.name) : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) {
        const bytes = await readFile(full);
        files.push({ path: rel.split(path.sep).join('/'), bytes: bytes.byteLength, sha256: sha256(bytes) });
      }
    }
  }
  await walk(root, '');
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

async function cacheTree(repo: string): Promise<{ files: FileDigest[]; sha256: string }> {
  const cache = path.join(repo, '.copperhead', 'llm-cache');
  const files = (await regularFiles(cache)).filter((file) => file.path.endsWith('.json'));
  return { files, sha256: digestRows(files) };
}

async function commandVersion(command: string, args: string[], cwd: string): Promise<string | null> {
  try {
    const result = await execa(command, args, { cwd });
    const text = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    return text || null;
  } catch {
    return null;
  }
}

async function tooling(cwd: string): Promise<ToolingManifest> {
  let kicadCli: string | null = null;
  try {
    kicadCli = (await kicadCliVersion()).trim() || null;
  } catch {
    // The final real ERC/DRC assertions will give the actionable failure if it is absent.
  }
  return {
    kicadCli,
    openspec: await commandVersion('openspec', ['--version'], cwd),
  };
}

function fixtureDir(): string {
  return path.resolve(process.env[FIXTURE_ENV]?.trim() || DEFAULT_FIXTURE_DIR);
}

function scratchRoot(): string {
  return process.env[TMP_ROOT_ENV]?.trim() || tmpdir();
}

function stripAnsi(line: string): string {
  return line.replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * Install a Date constructor whose no-argument reads follow the current stage.
 * Timers are intentionally untouched: only Date/Date.now are deterministic.
 */
function installStageClock(stages: StageClock[]): { observe: (line: string) => void; restore: () => void } {
  const NativeDate = globalThis.Date;
  let currentStage = 0;

  const stageIndex = (line: string): number | null => {
    const clean = stripAnsi(line).trimStart();
    const match = /^stage ([a-z0-9-]+): running(?: \(attempt (\d+)\/\d+\))?/.exec(clean);
    if (!match) return null;
    const index = stages.findIndex((stage) => stage.name === match[1]);
    return index >= 0 ? index : null;
  };

  class StageDate extends NativeDate {
    constructor();
    constructor(value: string | number | NativeDate);
    constructor(value?: string | number | NativeDate) {
      if (value === undefined) super(NativeDate.parse(stages[currentStage]!.at));
      else if (value instanceof NativeDate) super(value.getTime());
      else super(value);
    }

    static now(): number {
      return NativeDate.parse(stages[currentStage]!.at);
    }
  }

  (globalThis as unknown as { Date: DateConstructor }).Date = StageDate as unknown as DateConstructor;
  return {
    observe: (line: string) => {
      const next = stageIndex(line);
      if (next !== null) currentStage = next;
    },
    restore: () => {
      (globalThis as unknown as { Date: DateConstructor }).Date = NativeDate;
    },
  };
}

function standardStageClocks(): StageClock[] {
  // The fixed sequence gives every stage a distinct transcript directory and
  // keeps record/replay cache keys stable without freezing all stages together.
  const first = Date.UTC(2026, 0, 1, 0, 0, 0);
  return STAGES.map((stage, index) => ({
    name: stage.name,
    at: new Date(first + index * 24 * 60 * 60 * 1000).toISOString(),
  }));
}

function validateStageClocks(stages: StageClock[]): void {
  expect(stages).toHaveLength(STAGES.length);
  expect(stages.map((stage) => stage.name)).toEqual(STAGES.map((stage) => stage.name));
  const timestamps = stages.map((stage) => Date.parse(stage.at));
  expect(timestamps.every(Number.isFinite)).toBe(true);
  expect(new Set(timestamps).size).toBe(STAGES.length);
}

async function createRepo(briefSource: string, keep: boolean): Promise<RepoHandle> {
  // Do not use a `copperhead-*` prefix: runCreate's stale-temp sweep owns that
  // namespace, and a deterministic test clock must never remove its own repo.
  const repo = await mkdtemp(path.join(scratchRoot(), 'ch-e2e-repo-'));
  const briefRoot = await mkdtemp(path.join(scratchRoot(), 'ch-e2e-brief-'));
  const brief = path.join(briefRoot, BRIEF_BASENAME);
  await mkdir(path.join(repo, '.copperhead'), { recursive: true });
  await writeFile(path.join(repo, '.gitignore'), INITIAL_GITIGNORE, 'utf8');
  await writeFile(path.join(repo, '.copperhead', 'config.json'), INITIAL_CONFIG, 'utf8');
  await cp(briefSource, brief);
  await execa('git', ['init', '-q'], { cwd: repo });
  await execa('git', ['config', 'user.email', 'copperhead-e2e@localhost'], { cwd: repo });
  await execa('git', ['config', 'user.name', 'copperhead-e2e'], { cwd: repo });
  await execa('git', ['add', '-A'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', 'replay harness seed'], { cwd: repo });

  return {
    repo,
    brief,
    cleanup: async () => {
      if (keep) return;
      await Promise.all([
        rm(repo, { recursive: true, force: true }),
        rm(briefRoot, { recursive: true, force: true }),
      ]);
    },
  };
}

async function runCreateWithClock(
  repo: string,
  brief: string,
  model: string,
  clocks: StageClock[],
): Promise<CapturedCreate> {
  const logs: string[] = [];
  const clock = installStageClock(clocks);
  try {
    const result = await runCreate({
      repoRoot: repo,
      briefPath: brief,
      model,
      log: (line) => {
        clock.observe(line);
        logs.push(line);
      },
    });
    return { result, logs };
  } finally {
    clock.restore();
  }
}

async function readManifest(dir: string): Promise<ReplayManifest> {
  const file = path.join(dir, 'manifest.json');
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    throw new Error(`replay fixture is missing ${file}; run the record command first`);
  }
  let manifest: ReplayManifest;
  try {
    manifest = JSON.parse(raw) as ReplayManifest;
  } catch (error) {
    throw new Error(`replay fixture manifest is not valid JSON: ${(error as Error).message}`);
  }
  if (manifest.schemaVersion !== 1) throw new Error(`unsupported replay fixture schema: ${String(manifest.schemaVersion)}`);
  if (!manifest.model || manifest.brief?.file !== BRIEF_BASENAME || manifest.config?.file !== 'config.json') {
    throw new Error('replay fixture manifest has invalid model/brief/config identity');
  }
  validateStageClocks(manifest.clock?.stages ?? []);
  if (!manifest.cache?.directory || !manifest.cache.count || !manifest.cache.files?.length) {
    throw new Error('replay fixture manifest has no recorded cache entries');
  }
  return manifest;
}

async function verifyDigests(root: string, expected: FileDigest[]): Promise<void> {
  for (const row of expected) {
    const actual = await digestFile(root, row.path);
    expect(actual, row.path).toEqual(row);
  }
}

async function copyReplayInputs(dir: string, repo: string, manifest: ReplayManifest): Promise<string> {
  const briefSource = path.join(dir, manifest.brief.file);
  const configSource = path.join(dir, manifest.config.file);
  await verifyDigests(dir, [
    { path: manifest.brief.file, bytes: (await stat(briefSource)).size, sha256: manifest.brief.sha256 },
    { path: manifest.config.file, bytes: (await stat(configSource)).size, sha256: manifest.config.sha256 },
  ]);
  await cp(configSource, path.join(repo, '.copperhead', 'config.json'));

  const sourceCache = path.join(dir, manifest.cache.directory);
  const targetCache = path.join(repo, '.copperhead', 'llm-cache');
  await cp(sourceCache, targetCache, { recursive: true });
  const copiedCache = await cacheTree(repo);
  expect(copiedCache.files).toEqual(manifest.cache.files);
  expect(copiedCache.sha256).toBe(manifest.cache.sha256);

  const briefRoot = await mkdtemp(path.join(scratchRoot(), 'ch-e2e-replay-brief-'));
  const brief = path.join(briefRoot, BRIEF_BASENAME);
  await cp(briefSource, brief);
  return brief;
}

async function writeRecordFixture(
  dir: string,
  brief: string,
  manifest: ReplayManifest,
  cacheSource: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await cp(brief, path.join(dir, manifest.brief.file));
  await writeFile(path.join(dir, manifest.config.file), INITIAL_CONFIG, 'utf8');
  await rm(path.join(dir, manifest.cache.directory), { recursive: true, force: true });
  await cp(cacheSource, path.join(dir, manifest.cache.directory), { recursive: true });
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

async function stageRunDirs(repo: string): Promise<string[]> {
  const root = path.join(repo, '.copperhead', 'runs');
  const entries = await readdir(root, { withFileTypes: true });
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await stat(path.join(root, entry.name, 'transcript.jsonl')).then(() => true).catch(() => false)) {
      dirs.push(entry.name);
    }
  }
  return dirs.sort();
}

async function readReport(repo: string): Promise<{
  stages: Array<Record<string, unknown>>;
  total: Record<string, number>;
}> {
  const raw = await readFile(path.join(repo, '.copperhead', 'runs', 'report.json'), 'utf8');
  const report = JSON.parse(raw) as { stages?: Array<Record<string, unknown>>; total?: Record<string, number> };
  if (!Array.isArray(report.stages) || !report.total) throw new Error('create replay did not write a valid report.json');
  return { stages: report.stages, total: report.total };
}

async function assertRealPipeline(repo: string, result: Awaited<ReturnType<typeof runCreate>>): Promise<{
  report: Awaited<ReturnType<typeof readReport>>;
  cache: Awaited<ReturnType<typeof cacheTree>>;
}> {
  expect(result.ok).toBe(true);
  expect(result.completed).toEqual(STAGES.map((stage) => stage.name));

  const config = await loadConfig(repo);
  expect(config.schematic).toBeTruthy();
  expect(config.board).toBeTruthy();
  const schematic = path.join(repo, config.schematic!);
  const board = path.join(repo, config.board!);
  expect((await listSymbols(schematic)).length).toBeGreaterThan(0);

  const erc = await runErc(schematic);
  expect(erc.ok).toBe(true);
  expect(erc.violations).toHaveLength(0);
  const drc = await runDrc(board);
  expect(drc.ok).toBe(true);
  expect(drc.violations).toHaveLength(0);

  const checked = await runCheck(repo, () => {});
  expect(checked.ok).toBe(true);
  expect(checked.erc?.ok).toBe(true);
  expect(checked.drc?.ok).toBe(true);

  const devplan = await readFile(path.join(repo, config.docs, 'DEVPLAN.md'), 'utf8');
  expect(devplan.trim().length).toBeGreaterThan(0);
  const firmware = await regularFiles(path.join(repo, 'firmware'));
  const outputs = await regularFiles(path.join(repo, 'outputs'));
  expect(firmware.some((file) => file.bytes > 0)).toBe(true);
  expect(outputs.some((file) => file.bytes > 0)).toBe(true);

  const report = await readReport(repo);
  expect(report.stages.map((stage) => stage.name)).toEqual(STAGES.map((stage) => stage.name));
  const stageRuns = await stageRunDirs(repo);
  expect(stageRuns).toHaveLength(STAGES.length);
  for (const dir of stageRuns) {
    expect((await readFile(path.join(repo, '.copperhead', 'runs', dir, 'summary.md'), 'utf8')).trim().length).toBeGreaterThan(0);
  }

  const { stdout } = await execa('git', ['log', '--format=%H%x00%s'], { cwd: repo });
  const commits = stdout.split('\n').filter(Boolean).map((line) => {
    const [hash, ...subject] = line.split('\0');
    return { hash, subject: subject.join('\0') };
  });
  const stageCommits = STAGES.map((stage) => {
    const matches = commits.filter((commit) => commit.subject === `copperhead: create pipeline stage: ${stage.name}`);
    expect(matches, stage.name).toHaveLength(1);
    return matches[0]!.hash;
  });
  expect(new Set(stageCommits).size).toBe(STAGES.length);

  return { report, cache: await cacheTree(repo) };
}

async function record(): Promise<void> {
  if (modeConflict) throw new Error(`${RECORD_ENV}=1 cannot be combined with ${LLM_CACHE_ONLY_ENV}=1/${REPLAY_ENV}=1`);
  const model = process.env[MODEL_ENV]?.trim();
  if (!model) throw new Error(`record mode requires ${MODEL_ENV}=<real provider model>; no provider is mocked`);
  const fixture = fixtureDir();
  const clocks = standardStageClocks();
  const keep = process.env.COPPERHEAD_E2E_KEEP_TMP === '1';
  const repo = await createRepo(BRIEF_SOURCE, keep);
  try {
    const toolingManifest = await tooling(repo.repo);
    const initialTree = await trackedTree(repo.repo);
    const result = await runCreateWithClock(repo.repo, repo.brief, model, clocks);
    const checked = await assertRealPipeline(repo.repo, result.result);
    expect(checked.cache.files.length).toBeGreaterThan(0);
    expect(checked.cache.files.length).toBe(checked.report.total.turns);
    const briefData = await readFile(repo.brief);
    const finalTree = await trackedTree(repo.repo, true);
    const manifest: ReplayManifest = {
      schemaVersion: 1,
      model,
      brief: { file: BRIEF_BASENAME, sha256: sha256(briefData) },
      config: { file: 'config.json', sha256: sha256(INITIAL_CONFIG) },
      clock: { stages: clocks },
      tooling: toolingManifest,
      initialTree,
      cache: {
        directory: 'llm-cache',
        count: checked.cache.files.length,
        files: checked.cache.files,
        sha256: checked.cache.sha256,
      },
      finalTree,
    };
    await writeRecordFixture(fixture, repo.brief, manifest, path.join(repo.repo, '.copperhead', 'llm-cache'));
  } finally {
    await repo.cleanup();
  }
}

async function replay(): Promise<void> {
  if (modeConflict) throw new Error(`${RECORD_ENV}=1 cannot be combined with ${LLM_CACHE_ONLY_ENV}=1/${REPLAY_ENV}=1`);
  const fixture = fixtureDir();
  const manifest = await readManifest(fixture);
  const requestedModel = process.env[MODEL_ENV]?.trim();
  if (requestedModel && requestedModel !== manifest.model) {
    throw new Error(`replay model differs from the recorded model (${requestedModel} vs ${manifest.model})`);
  }
  const currentTooling = await tooling(fixture);
  expect(currentTooling).toEqual(manifest.tooling);
  const clocks = manifest.clock.stages;
  const keep = process.env.COPPERHEAD_E2E_KEEP_TMP === '1';

  const previousCacheOnly = process.env[LLM_CACHE_ONLY_ENV];
  process.env[LLM_CACHE_ONLY_ENV] = '1';
  try {
    for (let run = 0; run < 2; run++) {
      const repo = await createRepo(path.join(fixture, manifest.brief.file), keep);
      let briefRoot: string | null = null;
      try {
        const initialTree = await trackedTree(repo.repo);
        expect(initialTree).toEqual(manifest.initialTree);
        const brief = await copyReplayInputs(fixture, repo.repo, manifest);
        briefRoot = path.dirname(brief);
        const captured = await runCreateWithClock(repo.repo, brief, manifest.model, clocks);
        const checked = await assertRealPipeline(repo.repo, captured.result);
        expect(checked.cache.files).toEqual(manifest.cache.files);
        expect(checked.cache.sha256).toBe(manifest.cache.sha256);
        expect(checked.cache.files).toHaveLength(manifest.cache.count);
        expect(await trackedTree(repo.repo, true)).toEqual(manifest.finalTree);

        const report = checked.report;
        for (const stage of report.stages) {
          expect(stage.cacheHits, String(stage.name)).toBe(stage.turns);
          expect(stage.tokensIn, String(stage.name)).toBe(0);
          expect(stage.tokensOut, String(stage.name)).toBe(0);
        }
        expect(report.total.cacheHits).toBe(manifest.cache.count);
        expect(report.total.tokensIn).toBe(0);
        expect(report.total.tokensOut).toBe(0);
        const replayLogCount = captured.logs.filter((line) => line.includes('llm-cache: replayed a cached response')).length;
        expect(replayLogCount).toBe(report.total.turns);
      } finally {
        if (briefRoot && !keep) await rm(briefRoot, { recursive: true, force: true });
        await repo.cleanup();
      }
    }
  } finally {
    if (previousCacheOnly === undefined) delete process.env[LLM_CACHE_ONLY_ENV];
    else process.env[LLM_CACHE_ONLY_ENV] = previousCacheOnly;
  }
}

function appendTail(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length > CHILD_OUTPUT_LIMIT ? next.slice(-CHILD_OUTPUT_LIMIT) : next;
}

/** Kill a Vitest child and every provider/tool process it launched. */
function signalChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    // taskkill /T reaches descendants on Windows; /F is required because this
    // is the escalation path for a deadline, rather than an interrupt prompt.
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.unref();
    return;
  }
  try {
    // detached:true makes the child the process-group leader. A negative PID
    // targets that group, including a real provider CLI spawned by Vitest.
    process.kill(-child.pid, signal);
  } catch {
    // The child may have exited between the deadline and the signal.
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

function processGroupAlive(child: ChildProcess): boolean | null {
  if (child.pid === undefined) return false;
  if (process.platform === 'win32') return null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    // ESRCH is the only proof that the group is gone. Keep permission or
    // other OS errors unknown so the timeout message never claims a kill that
    // was merely attempted.
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : null;
  }
}

function processAlive(pid: number): boolean | null {
  if (process.platform === 'win32') return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : null;
  }
}

function childFailure(prefix: string, stdout: string, stderr: string): Error {
  return new Error(
    `${prefix}\nchild stdout (tail):\n${stdout || '(none)'}\nchild stderr (tail):\n${stderr || '(none)'}`,
  );
}

/** Wait for a child, escalating from TERM to KILL when the real deadline expires. */
async function waitForChildExit(child: ChildProcess, label: string, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let deadlineExpired = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let finalTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (finalTimer) clearTimeout(finalTimer);
      if (error) reject(error);
      else resolve();
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout = appendTail(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = appendTail(stderr, chunk);
    });
    child.once('error', (error) => finish(childFailure(`could not start isolated ${label} child: ${error.message}`, stdout, stderr)));
    child.once('close', (code, signal) => {
      if (settled) return;
      if (deadlineExpired) {
        // A leader can exit cleanly after TERM while a provider/tool child
        // remains in the detached process group. Never turn that into a
        // successful deadline run; the pending escalation must inspect/kill
        // the whole group first.
        if (processGroupAlive(child) === false) {
          finish(childFailure(`isolated ${label} child exceeded ${timeoutMs}ms; process group terminated`, stdout, stderr));
        }
        return;
      }
      if (code === 0) finish();
      else finish(childFailure(`isolated ${label} child exited with code ${String(code)}${signal ? ` (${signal})` : ''}`, stdout, stderr));
    });

    deadlineTimer = setTimeout(() => {
      if (settled) return;
      deadlineExpired = true;
      signalChildTree(child, 'SIGTERM');
      forceTimer = setTimeout(() => {
        if (settled) return;
        signalChildTree(child, 'SIGKILL');
        // A broken child process should never hold the parent test forever,
        // even if the OS fails to deliver the group signal.
        finalTimer = setTimeout(
          () => {
            const alive = processGroupAlive(child);
            finish(
              childFailure(
                `isolated ${label} child exceeded ${timeoutMs}ms; ` +
                  (alive === false ? 'process group terminated' : 'process group termination could not be confirmed'),
                stdout,
                stderr,
              ),
            );
          },
          KILL_GRACE_MS,
        );
      }, KILL_GRACE_MS);
    }, timeoutMs);
    deadlineTimer.unref?.();
  });
}

/**
 * Run the real record/replay test in a killable child. Vitest's in-process
 * timeout cannot stop a provider subprocess, so the parent owns the deadline
 * and the child owns the temporary repositories.
 */
async function runIsolated(modeToRun: 'record' | 'replay'): Promise<void> {
  const keep = process.env.COPPERHEAD_E2E_KEEP_TMP === '1';
  const scratch = await mkdtemp(path.join(tmpdir(), 'ch-e2e-parent-'));
  const testFile = path.join(TEST_DIR, 'create-pipeline-replay.test.ts');
  const vitestEntry = path.join(TEST_DIR, '..', 'node_modules', 'vitest', 'vitest.mjs');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [CHILD_ENV]: '1',
    [CHILD_MODE_ENV]: modeToRun,
    [TMP_ROOT_ENV]: scratch,
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [vitestEntry, 'run', testFile, '--no-file-parallelism'],
        {
          cwd: path.resolve(TEST_DIR, '..'),
          env,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      void waitForChildExit(child, modeToRun, E2E_TIMEOUT_MS).then(resolve, reject);
    });
  } finally {
    if (!keep) await rm(scratch, { recursive: true, force: true });
  }
}

const suite = mode === null ? describe.skip : describe;
const suiteTitle = mode === null
  ? `create pipeline E2E record/replay [SKIPPED by default; set ${RECORD_ENV}=1 or ${LLM_CACHE_ONLY_ENV}=1]`
  : 'create pipeline E2E record/replay';

suite(suiteTitle, () => {
  it(
    mode === 'record'
      ? 'records a complete real-provider run and writes a checksummed replay fixture'
      : 'replays the complete pipeline twice through cache-only real tools',
    async () => {
      if (mode === null) return;
      if (process.env[CHILD_ENV] === '1') {
        if (process.env[CHILD_MODE_ENV] !== mode) {
          throw new Error(`isolated E2E child mode mismatch: expected ${mode}`);
        }
        if (mode === 'record') await record();
        else await replay();
      } else {
        await runIsolated(mode);
      }
    },
    process.env[CHILD_ENV] === '1' ? E2E_TIMEOUT_MS : E2E_TIMEOUT_MS + (KILL_GRACE_MS * 2) + 10_000,
  );
});

// This small opt-in probe exercises only the process-group watchdog. It does
// not stand in for a provider or gate and never runs as part of record/replay.
const watchdogSuite = process.env[WATCHDOG_ENV] === '1' && process.env[CHILD_ENV] !== '1'
  ? describe
  : describe.skip;

watchdogSuite('isolated E2E watchdog', () => {
  it('kills the whole deadline group when the leader exits 0 but a descendant ignores SIGTERM', async () => {
    const descendantScript = 'process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000);';
    const leaderScript = [
      "const { spawn } = require('node:child_process');",
      `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'ignore' });`,
      "process.stdout.write(String(descendant.pid) + '\\n');",
      "process.on('SIGTERM', () => process.exit(0));",
      'setInterval(() => {}, 1000);',
    ].join(' ');
    const child = spawn(
      process.execPath,
      ['-e', leaderScript],
      {
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    );
    try {
      const descendantPid = await new Promise<number>((resolve, reject) => {
        if (!child.stdout) {
          reject(new Error('watchdog probe did not expose a stdout pipe'));
          return;
        }
        let output = '';
        const onData = (chunk: Buffer | string): void => {
          output += chunk.toString();
          const match = /(?:^|\n)(\d+)(?:\n|$)/.exec(output);
          if (!match) return;
          cleanup();
          resolve(Number(match[1]));
        };
        const onError = (error: Error): void => {
          cleanup();
          reject(error);
        };
        const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
          cleanup();
          reject(new Error(`watchdog leader closed before reporting descendant (${String(code)}${signal ? `/${signal}` : ''})`));
        };
        const cleanup = (): void => {
          child.stdout?.off('data', onData);
          child.off('error', onError);
          child.off('close', onClose);
        };
        child.stdout.on('data', onData);
        child.once('error', onError);
        child.once('close', onClose);
      });

      expect(Number.isInteger(descendantPid)).toBe(true);
      await expect(waitForChildExit(child, 'watchdog descendant probe', 100)).rejects.toThrow(/exceeded 100ms/);
      if (child.pid !== undefined && process.platform !== 'win32') {
        expect(processGroupAlive(child)).toBe(false);
        expect(processAlive(descendantPid)).toBe(false);
      }
    } finally {
      if (child.pid !== undefined && processGroupAlive(child) !== false) {
        signalChildTree(child, 'SIGKILL');
      }
    }
  }, KILL_GRACE_MS * 3 + 5_000);
});
