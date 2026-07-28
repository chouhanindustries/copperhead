import { describe, it, expect, vi } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

import { runCreate, STAGES } from '../src/commands/create.js';
import { listSymbols } from '../src/kicad/sexp.js';

/**
 * End-to-end deterministic replay of the full `copperhead create` pipeline
 * (bounty acceptance criterion: coverage that exercises the pipeline
 * end-to-end and fails on a wedged stage, a false-green gate, or the final
 * stage not being reached).
 *
 * How it works: a real successful run's LLM turns live in
 * test/fixtures/e2e-replay/llm-cache/ (the CachingProvider's on-disk format,
 * src/agent/response-cache.ts). The test seeds a fresh temp git repo with the
 * fixture brief and that cache, then runs the REAL pipeline: real agent loop,
 * real tool dispatch, real kicad-cli ERC/DRC/exports, real git commits. Every
 * provider turn is served from the cache, so the run is deterministic and
 * makes ZERO live LLM calls. Any divergence from the recording is a cache
 * miss, which the assertions below (and COPPERHEAD_CACHE_ONLY, if the loop
 * supports it) turn into a hard failure.
 *
 * Determinism contract (see also the recording notes in the fixture dir):
 *  - Date is frozen (only Date is faked; real timers keep the watchdog alive).
 *    docs/CHANGELOG.md (loop.ts appendChangelog) and docs/DECISIONS.md
 *    (tools.ts record_decision) embed the date and the run id, and both docs
 *    are folded into every later stage's system prompt — an unfrozen clock
 *    changes the cache key at the first stage boundary. The fixture MUST be
 *    recorded through this same test (COPPERHEAD_E2E_RECORD=1) so recording
 *    and replay share the frozen clock and the derived run id.
 *  - The model string is part of the cache key, so it is pinned in the
 *    fixture manifest, not taken from the environment.
 *  - SYNAP_API_KEY is cleared: Synap recall text is appended to the system
 *    prompt and would poison the cache key.
 *  - openspec-CLI availability changes validate_change's result text (a tool
 *    result feeds the next turn's cache key), so the manifest records whether
 *    it was on PATH at recording time and replay asserts parity.
 *  - kicad-cli must be the same major version as at recording time (ERC and
 *    verify_symbols text feeds the cache key). CI pins KiCad via the PPA.
 *
 * Recording: on a machine with a working provider login,
 *   COPPERHEAD_E2E_RECORD=1 COPPERHEAD_E2E_MODEL=claude-code \
 *     npx vitest run test/e2e-replay.test.ts
 * runs the pipeline live (misses fall through to the provider), then copies
 * the temp repo's .copperhead/llm-cache back into the fixture and writes
 * manifest.json. Replays need no credentials at all.
 */

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'e2e-replay');
const BRIEF_FIXTURE = path.join(FIXTURE_DIR, 'brief.md');
const CACHE_FIXTURE = path.join(FIXTURE_DIR, 'llm-cache');
const MANIFEST = path.join(FIXTURE_DIR, 'manifest.json');

/** Everything replay must hold identical to the recording environment. */
interface ReplayManifest {
  /** Model string passed to runCreate; part of every cache key (response-cache.ts keyFor). */
  model: string;
  /** The frozen wall clock both recording and replay run under. */
  frozenTime: string;
  /** Whether the `openspec` CLI was on PATH at recording time. */
  openspecOnPath: boolean;
}

const RECORD = process.env.COPPERHEAD_E2E_RECORD === '1';
const RECORD_MODEL = process.env.COPPERHEAD_E2E_MODEL ?? 'claude-code';
const DEFAULT_FROZEN_TIME = '2026-01-01T00:00:00.000Z';

/** Replay is possible only when the pre-recorded fixture is present. */
const replayable =
  existsSync(BRIEF_FIXTURE) &&
  existsSync(CACHE_FIXTURE) &&
  readdirSync(CACHE_FIXTURE).some((f) => f.endsWith('.json'));

/** In CI a missing prerequisite is a broken job, not a reason to skip. */
const strict = RECORD || process.env.CI === 'true';

async function onPath(cmd: string): Promise<boolean> {
  return execa(cmd, ['--version']).then(
    () => true,
    () => false,
  );
}

/** Env vars that would leak nondeterminism into the run; cleared for its duration. */
const SANITIZED_ENV = ['SYNAP_API_KEY', 'COPPERHEAD_CC_SESSION_RESUME', 'COPPERHEAD_MODEL', 'COPPERHEAD_MIN_FREE_MB'];

describe.skipIf(!RECORD && !replayable)('create pipeline: deterministic end-to-end replay', () => {
  it(
    'replays all 8 stages from the llm-cache with zero live LLM calls',
    async (ctx) => {
      if (!(await onPath('kicad-cli'))) {
        if (strict) throw new Error('e2e replay requires kicad-cli on PATH (CI installs it; see .github/workflows/ci.yml)');
        return ctx.skip();
      }

      const manifest: ReplayManifest = RECORD
        ? { model: RECORD_MODEL, frozenTime: DEFAULT_FROZEN_TIME, openspecOnPath: await onPath('openspec') }
        : (JSON.parse(await readFile(MANIFEST, 'utf8')) as ReplayManifest);

      // Tool results feed the next turn's cache key, and validate_change's
      // result text depends on whether the openspec CLI exists. Refuse to run
      // in an environment that disagrees with the recording rather than fail
      // later with an opaque cache miss.
      if (!RECORD && (await onPath('openspec')) !== manifest.openspecOnPath) {
        throw new Error(
          `openspec-CLI availability differs from the recording (manifest says openspecOnPath=${manifest.openspecOnPath}); ` +
            'install/remove it to match, or re-record the fixture in this environment',
        );
      }

      const savedEnv: Record<string, string | undefined> = {};
      for (const k of SANITIZED_ENV) {
        savedEnv[k] = process.env[k];
        delete process.env[k];
      }
      // Strict replay: with the cache-only patch in place, any miss throws at
      // the divergent turn instead of falling through to a live provider call.
      // Harmless if the flag is not (yet) supported; the report.json
      // assertions below still catch every miss.
      if (!RECORD) process.env.COPPERHEAD_CACHE_ONLY = '1';

      // Freeze ONLY Date. appendChangelog (src/agent/loop.ts) stamps the date
      // into CHANGELOG.md, record_decision (src/agent/tools.ts) stamps date +
      // run id into DECISIONS.md, and the run id is the Transcript dir name
      // derived from `new Date()` (src/agent/transcript.ts) — all of which end
      // up inside later stages' system prompts and therefore inside cache
      // keys. Real timers stay live so the turn watchdog and retry backoff
      // still work.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(manifest.frozenTime));

      const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-e2e-'));
      try {
        // Seed the repo under test: brief + target-repo .gitignore convention
        // (AC-4.3) + a pinned pipeline config. maxStageRetries: 0 makes any
        // stage failure terminal immediately — the retry path calls a LIVE
        // diagnosis model, which a replay test must never reach. The config is
        // committed before the run so recording and replay share it (it feeds
        // budgets/turn arithmetic that shape the prompts).
        await writeFile(path.join(repo, '.gitignore'), '.env\n.copperhead/runs/\n.copperhead/llm-cache/\n', 'utf8');
        await cp(BRIEF_FIXTURE, path.join(repo, 'brief.md'));
        await mkdir(path.join(repo, '.copperhead'), { recursive: true });
        await writeFile(path.join(repo, '.copperhead', 'config.json'), JSON.stringify({ maxStageRetries: 0 }, null, 2) + '\n', 'utf8');
        await execa('git', ['init', '-q'], { cwd: repo });
        await execa('git', ['config', 'user.email', 'test@copperhead.local'], { cwd: repo });
        await execa('git', ['config', 'user.name', 'copperhead-test'], { cwd: repo });
        await execa('git', ['add', '-A'], { cwd: repo });
        await execa('git', ['commit', '-q', '-m', 'e2e replay seed'], { cwd: repo });

        // Pre-recorded turns: every provider call the pipeline is about to
        // make already has its response on disk (replay mode only).
        if (!RECORD) {
          await cp(CACHE_FIXTURE, path.join(repo, '.copperhead', 'llm-cache'), { recursive: true });
        }

        const lines: string[] = [];
        const res = await runCreate({
          repoRoot: repo,
          briefPath: path.join(repo, 'brief.md'),
          model: manifest.model,
          log: (s) => lines.push(s),
        });
        const logText = lines.join('\n');

        // (a) the pipeline resolves with success and reaches the final stage —
        // a wedged stage or an early stop fails here (or at the test timeout).
        expect(res.ok, `pipeline did not complete cleanly; log tail:\n${lines.slice(-30).join('\n')}`).toBe(true);
        expect(res.completed).toEqual(STAGES.map((s) => s.name));
        expect(res.completed).toHaveLength(8);

        // (b) each completed stage was committed to git in the repo under test.
        const { stdout: gitLog } = await execa('git', ['log', '--format=%s'], { cwd: repo });
        for (const stage of STAGES) {
          expect(gitLog, `missing commit for stage ${stage.name}`).toContain(`copperhead: create pipeline stage: ${stage.name}`);
        }

        // (c) the final stage's artifact exists.
        expect(existsSync(path.join(repo, 'docs', 'DEVPLAN.md')), 'docs/DEVPLAN.md missing (devplan stage artifact)').toBe(true);

        // (d) the run report covers all 8 stages, in order, each either run or
        // legitimately resumed (writeRunReport in src/commands/create.ts).
        const reportPath = path.join(repo, '.copperhead', 'runs', 'report.json');
        expect(existsSync(reportPath), '.copperhead/runs/report.json missing').toBe(true);
        expect(existsSync(path.join(repo, '.copperhead', 'runs', 'REPORT.md')), '.copperhead/runs/REPORT.md missing').toBe(true);
        const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
          stageCount: number;
          ran: number;
          resumed: number;
          stages: Array<{ name: string; resumed: boolean; turns: number; cacheHits: number }>;
          total: { turns: number; tokensIn: number; tokensOut: number; cacheHits: number; cacheHitPct: number };
        };
        expect(report.stageCount).toBe(8);
        expect(report.stages.map((s) => s.name)).toEqual(STAGES.map((s) => s.name));
        expect(report.ran + report.resumed).toBe(8);
        for (const s of report.stages) {
          if (!s.resumed) expect(s.turns, `stage ${s.name} reported zero turns yet was not resumed`).toBeGreaterThan(0);
        }

        // (e) false-green ERC guard: the committed schematic contains real
        // symbols. A zero-symbol sheet passes ERC "clean", so ERC alone is not
        // evidence of a design; count symbols in the s-expression source.
        const config = JSON.parse(await readFile(path.join(repo, '.copperhead', 'config.json'), 'utf8')) as {
          schematic: string | null;
        };
        expect(config.schematic, 'no schematic wired into .copperhead/config.json').toBeTruthy();
        const symbols = await listSymbols(path.join(repo, config.schematic as string));
        expect(symbols.length, 'schematic has zero symbols: ERC "clean" here is a false green').toBeGreaterThan(0);

        // (f) ZERO live LLM calls: every turn of every ran stage was served
        // from the cache. Three independent signals so a single reporting bug
        // cannot mask a live call:
        //   1. per-stage cacheHits === turns (report.json, fed by
        //      CachingProvider.cacheHits through RunResult.cacheHits);
        //   2. total token usage is exactly 0 (a cache hit reports zero usage
        //      by construction, response-cache.ts; any live turn adds real usage);
        //   3. one "llm-cache: replayed" log line per turn.
        if (!RECORD) {
          for (const s of report.stages) {
            if (!s.resumed) expect(s.cacheHits, `stage ${s.name}: ${s.turns - s.cacheHits} turn(s) missed the cache`).toBe(s.turns);
          }
          expect(report.total.cacheHits).toBe(report.total.turns);
          expect(report.total.tokensIn, 'nonzero input tokens: at least one live provider call happened').toBe(0);
          expect(report.total.tokensOut, 'nonzero output tokens: at least one live provider call happened').toBe(0);
          const replayLines = lines.filter((l) => l.includes('llm-cache: replayed')).length;
          expect(replayLines).toBe(report.total.turns);
          expect(logText).not.toContain('provider error');
        }

        // Record mode: harvest the cache this live run just paid for into the
        // fixture, plus the manifest that pins the replay environment.
        if (RECORD) {
          await rm(CACHE_FIXTURE, { recursive: true, force: true });
          await cp(path.join(repo, '.copperhead', 'llm-cache'), CACHE_FIXTURE, { recursive: true });
          await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
        }
      } finally {
        vi.useRealTimers();
        delete process.env.COPPERHEAD_CACHE_ONLY;
        for (const k of SANITIZED_ENV) {
          if (savedEnv[k] === undefined) delete process.env[k];
          else process.env[k] = savedEnv[k];
        }
        await rm(repo, { recursive: true, force: true });
      }
    },
    // Replay executes every real tool call (kicad-cli ERC/DRC, gerber/STEP
    // exports, git) across 8 stages; only the LLM turns are instant. Recording
    // is slower still. This is also the wedged-stage backstop: a replay that
    // hangs (instead of missing the cache) dies here.
    RECORD ? 3_600_000 : 900_000,
  );
});
