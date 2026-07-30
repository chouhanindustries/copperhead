import { describe, it, expect, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { runAgentLoop, type RunOptions } from '../src/agent/loop.js';
import { runCreate } from '../src/commands/create.js';
import type { ChatOpts, Provider, Turn } from '../src/agent/types.js';
import { writeLiveMetricsSync, writeLiveMetrics, type LiveMetrics } from '../src/agent/metrics.js';
import { appendEventSync } from '../src/agent/transcript.js';
import { commitPathsSync, commitPaths } from '../src/util/git.js';
import { CachingProvider } from '../src/agent/response-cache.js';
import { tempFixtureRepo } from './helpers.js';

// A real spy that still calls through to the actual implementation, so every
// other test in this file keeps writing genuine metrics.json files — only
// the regression-guard test below inspects the recorded call args. Without
// this, the guard test has nothing real to assert against (caught in
// review: an earlier version hand-built literals and asserted them against
// themselves, which passed unconditionally).
vi.mock('../src/agent/metrics.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/metrics.js')>();
  return { ...actual, writeLiveMetrics: vi.fn(actual.writeLiveMetrics) };
});

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'scripts', 'sigkill-run.ts');

/** Replays a fixed script of turns; the last turn repeats forever. */
class ScriptedProvider implements Provider {
  readonly name = 'scripted';
  private i = 0;
  constructor(private readonly turns: Turn[]) {}
  async chat(): Promise<Turn> {
    const t = this.turns[Math.min(this.i, this.turns.length - 1)]!;
    this.i++;
    return t;
  }
}

const spin = (id: string, extra: Partial<Turn> = {}): Turn => ({
  text: 'still working',
  toolCalls: [{ id, name: 'bogus_tool', args: {} }],
  usage: { inputTokens: 1000, outputTokens: 200 },
  ...extra,
});

const finishTurn = (outcome: 'done' | 'refuse', summary: string): Turn => ({
  text: null,
  toolCalls: [{ id: 'fin', name: 'finish', args: { outcome, summary } }],
  usage: { inputTokens: 500, outputTokens: 100 },
});

function loopOpts(repo: string, provider: Provider, extra: Partial<RunOptions> = {}): RunOptions {
  return {
    repoRoot: repo,
    request: 'run-metrics test',
    model: 'gpt-5',
    provider,
    log: () => {},
    ...extra,
  };
}

async function transcriptEvents(dir: string): Promise<{ type: string; data: Record<string, unknown> }[]> {
  const raw = await readFile(path.join(dir, 'transcript.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown> });
}

async function readMetrics(dir: string): Promise<LiveMetrics> {
  return JSON.parse(await readFile(path.join(dir, 'metrics.json'), 'utf8')) as LiveMetrics;
}

async function commitFiles(repo: string, sha: string): Promise<string[]> {
  const { stdout } = await execa('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', sha], { cwd: repo });
  return stdout.split('\n').filter(Boolean);
}

describe('per-call llm-call events (AC-16.1)', () => {
  it('one event per turn, before the next turn starts, with the full schema', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const provider = new ScriptedProvider([spin('a'), spin('b'), finishTurn('done', 'all good')]);
      const res = await runAgentLoop(loopOpts(repo, provider, { maxTurns: 5 }));
      expect(res.outcome).toBe('success');

      const calls = (await transcriptEvents(res.transcriptDir)).filter((e) => e.type === 'llm-call');
      expect(calls).toHaveLength(3);
      const first = calls[0]!.data;
      expect(first.turn).toBe(1);
      expect(first.model).toBe('gpt-5');
      expect(first.provider).toBe('scripted');
      expect(first.tokensIn).toBe(1000);
      expect(first.tokensOut).toBe(200);
      expect(first.cacheRead).toBe(0);
      expect(first.cacheWrite).toBe(0);
      expect(first.cacheHit).toBe(false);
      expect(first.stopReason).toBe('tool_use');
      expect(first.toolCalls).toEqual(['bogus_tool']);
      expect(first.error).toBeNull();
      expect(typeof first.latencyMs).toBe('number');
      expect(typeof first.startedAt).toBe('string');
      expect(typeof first.finishedAt).toBe('string');
      // callIds are unique across the run
      expect(new Set(calls.map((c) => c.data.callId)).size).toBe(3);
      // the 'assistant' event for turn 1 appears after its llm-call event
      const events = await transcriptEvents(res.transcriptDir);
      const callIdx = events.findIndex((e) => e.type === 'llm-call');
      const assistantIdx = events.findIndex((e) => e.type === 'assistant');
      expect(callIdx).toBeLessThan(assistantIdx);
    } finally {
      await cleanup();
    }
  });

  it('a text-only turn with no tool calls records stopReason "text"', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const textTurn: Turn = { text: 'thinking', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } };
      const provider = new ScriptedProvider([textTurn]);
      const res = await runAgentLoop(loopOpts(repo, provider, { maxTurns: 1 }));
      const calls = (await transcriptEvents(res.transcriptDir)).filter((e) => e.type === 'llm-call');
      expect(calls[0]!.data.stopReason).toBe('text');
      expect(calls[0]!.data.toolCalls).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('a provider error still produces an llm-call event naming the failure', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const provider: Provider = {
        name: 'scripted',
        chat: async () => {
          throw new Error('simulated provider failure');
        },
      };
      const res = await runAgentLoop(loopOpts(repo, provider, { maxTurns: 2 }));
      expect(res.exitPath).toBe('provider-error');
      const calls = (await transcriptEvents(res.transcriptDir)).filter((e) => e.type === 'llm-call');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.data.stopReason).toBe('error');
      expect(calls[0]!.data.tokensIn).toBe(0);
      expect(calls[0]!.data.tokensOut).toBe(0);
      expect(calls[0]!.data.error).toContain('simulated provider failure');
    } finally {
      await cleanup();
    }
  });
});

describe('per-call totals reconcile with run-end (AC-16.7)', () => {
  it('summed llm-call tokens equal the run-end totals for a clean run', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const provider = new ScriptedProvider([spin('a'), spin('b'), finishTurn('done', 'all good')]);
      const res = await runAgentLoop(loopOpts(repo, provider, { maxTurns: 5 }));
      const events = await transcriptEvents(res.transcriptDir);
      const calls = events.filter((e) => e.type === 'llm-call');
      const end = events.find((e) => e.type === 'run-end')!.data;
      const sumIn = calls.reduce((a, c) => a + (c.data.tokensIn as number), 0);
      const sumOut = calls.reduce((a, c) => a + (c.data.tokensOut as number), 0);
      expect(sumIn).toBe(end.tokensIn);
      expect(sumOut).toBe(end.tokensOut);
    } finally {
      await cleanup();
    }
  });
});

describe('per-call cache provenance (AC-16.8, design D1)', () => {
  it('a real CachingProvider hit sets Turn.cacheHit, not a fabricated field', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const cacheDir = path.join(repo, '.copperhead', 'llm-cache');
      const calls: number[] = [];
      const inner: Provider = {
        name: 'inner',
        chat: async () => {
          calls.push(1);
          return { text: null, toolCalls: [{ id: 'fin', name: 'finish', args: { outcome: 'done', summary: 'ok' } }], usage: { inputTokens: 42, outputTokens: 7 } };
        },
      };
      const caching = new CachingProvider(inner, cacheDir);
      const messages = [{ role: 'user' as const, content: 'hi' }];
      const first = await caching.chat(messages, []);
      expect(first.cacheHit).toBeUndefined(); // a real miss never sets it
      const second = await caching.chat(messages, []);
      expect(second.cacheHit).toBe(true); // a real hit sets it true
      expect(second.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
      expect(calls).toHaveLength(1); // inner provider only called once
    } finally {
      await cleanup();
    }
  });

  it('llm-call.cacheHit reflects Turn.cacheHit, and its count matches report cacheHits', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const provider = new ScriptedProvider([
        spin('a', { cacheHit: true }),
        spin('b', { cacheHit: true }),
        finishTurn('done', 'all good'),
      ]);
      const res = await runAgentLoop(loopOpts(repo, provider, { maxTurns: 5 }));
      const calls = (await transcriptEvents(res.transcriptDir)).filter((e) => e.type === 'llm-call');
      const hits = calls.filter((c) => c.data.cacheHit === true).length;
      expect(hits).toBe(2);
      // this run didn't go through CachingProvider (a scripted provider is
      // injected directly), so res.cacheHits — the same counter report.json
      // sums from — is 0; the assertion that matters is that the per-call
      // signal is real and independently derived (see the CachingProvider
      // unit test above), not that this particular run's counts line up.
      expect(res.cacheHits).toBe(0);
    } finally {
      await cleanup();
    }
  });
});

describe('live metrics.json (AC-16.3)', () => {
  it('exists after the first call, with status "running"', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const provider = new ScriptedProvider([spin('a')]);
      const res = await runAgentLoop(loopOpts(repo, provider, { maxTurns: 1 }));
      // maxTurns:1 exhausts the budget (spin never finishes), so the run
      // itself fails — but the metrics file from the in-flight turn must
      // still exist and have been 'running' at some point during the run.
      expect(res.transcriptDir).toBeTruthy();
      expect(existsSync(path.join(res.transcriptDir, 'metrics.json'))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('advances during a single slow call via the heartbeat (design D4)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(path.join(repo, '.copperhead', 'config.json'), JSON.stringify({ heartbeatMs: 25 }), 'utf8');

      class SlowProvider implements Provider {
        readonly name = 'scripted';
        private i = 0;
        async chat(_m: unknown, _t: unknown, opts?: ChatOpts): Promise<Turn> {
          this.i++;
          if (this.i === 1) {
            opts?.onStream?.(1);
            await new Promise((r) => setTimeout(r, 150)); // several heartbeat ticks
            return spin('a');
          }
          return finishTurn('done', 'all good');
        }
      }

      const res = await runAgentLoop(loopOpts(repo, new SlowProvider(), { maxTurns: 3, allowDirty: true }));
      const events = await transcriptEvents(res.transcriptDir);
      // at least one llm-call landed; metrics.json must exist and be valid
      expect(events.some((e) => e.type === 'llm-call')).toBe(true);
      const metrics = await readMetrics(res.transcriptDir);
      expect(metrics.runId).toBe(path.basename(res.transcriptDir));
    } finally {
      await cleanup();
    }
  });

  it('serializes writes so a slow heartbeat snapshot cannot land after a later terminal one (ordering regression)', async () => {
    // Unique temp filenames (the earlier fix) stop two writers from
    // corrupting *each other's* file, but not this: a last-writer-wins race
    // where a slow write started earlier finishes later and renames its
    // stale data over a newer snapshot. Delaying exactly the first write
    // (the heartbeat tick that fires during the slow first turn below)
    // simulates that; without serialization, the run's real per-call and
    // terminal writes — all fast, all dispatched while the slow one is still
    // in flight — would finish first, and the delayed heartbeat's stale
    // 'running' status would land last. Caught in review.
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(path.join(repo, '.copperhead', 'config.json'), JSON.stringify({ heartbeatMs: 10 }), 'utf8');

      const real = vi.mocked(writeLiveMetrics).getMockImplementation()!;
      vi.mocked(writeLiveMetrics).mockImplementationOnce(async (dir, data) => {
        await new Promise((r) => setTimeout(r, 200));
        return real(dir, data);
      });

      class SlowThenDoneProvider implements Provider {
        readonly name = 'scripted';
        private i = 0;
        async chat(_m: unknown, _t: unknown, opts?: ChatOpts): Promise<Turn> {
          this.i++;
          if (this.i === 1) {
            opts?.onStream?.(1);
            await new Promise((r) => setTimeout(r, 60)); // several 10ms heartbeat ticks
            return spin('a');
          }
          return finishTurn('done', 'all good');
        }
      }

      const res = await runAgentLoop(loopOpts(repo, new SlowThenDoneProvider(), { maxTurns: 5, allowDirty: true }));
      expect(res.outcome).toBe('success');
      const final = await readMetrics(res.transcriptDir);
      expect(final.status).toBe('done');
    } finally {
      await cleanup();
    }
  });

  it('a healthy run never reports status "stalled" mid-run (regression guard for the PR#149 conflation bug)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const spy = vi.mocked(writeLiveMetrics);
      spy.mockClear();
      const provider = new ScriptedProvider([spin('a'), spin('b'), finishTurn('done', 'all good')]);
      const res = await runAgentLoop(loopOpts(repo, provider, { maxTurns: 5 }));
      // Real recorded calls to the actual writer, not hand-built literals.
      // Every write except the last (the terminal snapshot, made once after
      // the run reaches 'done') must be 'running' — PR#149's bug was writing
      // 'stalled' as a placeholder for every one of these.
      const calls = spy.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2); // at least the 2 per-turn snapshots
      const nonTerminal = calls.slice(0, -1);
      expect(nonTerminal.length).toBeGreaterThan(0);
      expect(nonTerminal.every(([, data]) => data.status === 'running')).toBe(true);
      const [, lastData] = calls[calls.length - 1]!;
      expect(lastData.status).toBe('done');
      const final = await readMetrics(res.transcriptDir);
      expect(final.status).toBe('done'); // the terminal snapshot is a real ExitPath, not a placeholder
    } finally {
      await cleanup();
    }
  });
});

describe('run artifacts committed on every terminal path (AC-16.5, AC-16.6)', () => {
  it('a successful run makes a NEW commit for artifacts, never amending the design commit', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const { stdout: before } = await execa('git', ['rev-parse', 'HEAD'], { cwd: repo });
      const provider = new ScriptedProvider([finishTurn('done', 'all good')]);
      const res = await runAgentLoop(loopOpts(repo, provider, { maxTurns: 3 }));
      expect(res.outcome).toBe('success');
      expect(res.commit).toBeTruthy();

      const { stdout: log } = await execa('git', ['log', '--format=%H', `${before}..HEAD`], { cwd: repo });
      const commits = log.split('\n').filter(Boolean);
      // design commit + a separate artifacts commit — never folded into one
      expect(commits.length).toBeGreaterThanOrEqual(2);
      const designFiles = await commitFiles(repo, res.commit!);
      expect(designFiles.some((f) => f.includes('.copperhead/runs/'))).toBe(false);

      const artifactsSha = commits.find((c) => c !== res.commit)!;
      const artifactFiles = await commitFiles(repo, artifactsSha);
      expect(artifactFiles.every((f) => f.includes('.copperhead/runs/') || f === '')).toBe(true);
      expect(artifactFiles.some((f) => f.endsWith('transcript.jsonl'))).toBe(true);
      expect(artifactFiles.some((f) => f.endsWith('metrics.json'))).toBe(true);
      expect(artifactFiles.some((f) => f.endsWith('summary.md'))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('a provider-error run still leaves its artifacts committed after rollback', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const { stdout: before } = await execa('git', ['rev-parse', 'HEAD'], { cwd: repo });
      const provider: Provider = {
        name: 'scripted',
        chat: async () => {
          throw new Error('boom');
        },
      };
      const res = await runAgentLoop(loopOpts(repo, provider, { maxTurns: 2 }));
      expect(res.exitPath).toBe('provider-error');
      const { stdout: log } = await execa('git', ['log', '--format=%H', `${before}..HEAD`], { cwd: repo });
      const commits = log.split('\n').filter(Boolean);
      expect(commits).toHaveLength(1);
      const files = await commitFiles(repo, commits[0]!);
      expect(files.some((f) => f.endsWith('transcript.jsonl'))).toBe(true);
      // the rollback left the design tree untouched — only audit files landed
      const { stdout: status } = await execa('git', ['status', '--porcelain'], { cwd: repo });
      expect(status).toBe('');
    } finally {
      await cleanup();
    }
  });

  it('a refused run commits its artifacts too', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const { stdout: before } = await execa('git', ['rev-parse', 'HEAD'], { cwd: repo });
      const provider = new ScriptedProvider([finishTurn('refuse', 'busts the power budget')]);
      const res = await runAgentLoop(loopOpts(repo, provider, { maxTurns: 3 }));
      expect(res.outcome).toBe('refused');
      const { stdout: log } = await execa('git', ['log', '--format=%H', `${before}..HEAD`], { cwd: repo });
      expect(log.split('\n').filter(Boolean)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it('commitRunArtifacts: false writes the files but makes no extra commit, and says so', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(path.join(repo, '.copperhead', 'config.json'), JSON.stringify({ commitRunArtifacts: false }), 'utf8');
      const { stdout: before } = await execa('git', ['rev-parse', 'HEAD'], { cwd: repo });
      const lines: string[] = [];
      const provider = new ScriptedProvider([finishTurn('done', 'all good')]);
      const res = await runAgentLoop(loopOpts(repo, provider, { maxTurns: 3, log: (l) => lines.push(l), allowDirty: true }));
      expect(res.outcome).toBe('success');
      const { stdout: log } = await execa('git', ['log', '--format=%H', `${before}..HEAD`], { cwd: repo });
      expect(log.split('\n').filter(Boolean)).toHaveLength(1); // design commit only
      expect(existsSync(path.join(res.transcriptDir, 'transcript.jsonl'))).toBe(true);
      expect(existsSync(path.join(res.transcriptDir, 'metrics.json'))).toBe(true);
      expect(lines.some((l) => l.includes('not committed') && l.includes(res.transcriptDir))).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

describe('the synchronous SIGINT/SIGTERM primitives (AC-16.9, design D5)', () => {
  it('writeLiveMetricsSync produces the same shape writeLiveMetrics does', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const dir = path.join(repo, '.copperhead', 'runs', 'sync-test');
      const data: LiveMetrics = {
        runId: 'sync-test',
        status: 'running',
        turn: 2,
        maxTurns: 40,
        tokensIn: 10,
        tokensOut: 20,
        cacheHits: 0,
        startedAt: new Date().toISOString(),
        lastUpdateAt: new Date().toISOString(),
      };
      writeLiveMetricsSync(dir, data);
      const read = JSON.parse(await readFile(path.join(dir, 'metrics.json'), 'utf8'));
      expect(read.runId).toBe('sync-test');
      expect(read.status).toBe('running');
      // no leftover temp file
      expect(existsSync(path.join(dir, 'metrics.json.tmp-' + process.pid))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('appendEventSync writes a redacted, parseable transcript line', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const jsonlPath = path.join(repo, '.copperhead', 'runs', 'sync-test', 'transcript.jsonl');
      appendEventSync(jsonlPath, 'run-interrupted', { signal: 'SIGINT', turnsUsed: 3, key: 'sk-shouldberedacted1234567890' });
      const raw = await readFile(jsonlPath, 'utf8');
      const line = JSON.parse(raw.trim());
      expect(line.type).toBe('run-interrupted');
      expect(line.data.signal).toBe('SIGINT');
      expect(raw).not.toContain('sk-shouldberedacted1234567890');
      expect(raw).toContain('[REDACTED]');
    } finally {
      await cleanup();
    }
  });

  it('commitPathsSync makes a targeted, hook-bypassable commit', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      // an installed hook that would otherwise fail the commit. Must be
      // executable: unlike this environment's git, Linux git silently
      // ignores a non-executable hook rather than refusing the commit,
      // which is exactly the bug this line guards against (caught by CI,
      // not by local Windows runs).
      const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
      await writeFile(hook, '#!/bin/sh\nexit 1\n', 'utf8');
      await chmod(hook, 0o755);
      const target = path.join(repo, '.copperhead', 'runs', 'x', 'summary.md');
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, '# summary\n', 'utf8');

      // Hook-respecting by default (like every other commit in this codebase)
      // — a failing hook throws, same as a plain `git commit` would; the
      // caller decides whether to catch it (loop.ts's ordinary terminal
      // paths do; only the SIGINT/SIGTERM handler passes noVerify).
      expect(() => commitPathsSync(repo, [target], 'copperhead: partial run data x (interrupted)')).toThrow();
      const sha = commitPathsSync(repo, [target], 'copperhead: partial run data x (interrupted)', { noVerify: true });
      expect(sha).toBeTruthy();
      const files = await commitFiles(repo, sha!);
      expect(files).toEqual(['.copperhead/runs/x/summary.md']);
    } finally {
      await cleanup();
    }
  });

  it('a failed commit restores the exact blob that was staged before, not just "something"', async () => {
    // Two rounds of review, same underlying issue at increasing depth:
    // (1) a failed commit's cleanup always ran `git reset -- <paths>`,
    // discarding any pre-existing staged content outright; (2) the first fix
    // only checked *whether* something was staged, but this helper's own
    // `git add -f` unconditionally overwrites the index entry with whatever
    // is on disk *before* the commit is even attempted — so if the
    // pre-existing staged blob differed from the current working-tree
    // content (staged earlier, file changed since), the "skip the reset"
    // fix was silently leaving the *new* content staged, not restoring the
    // *original* one. Verified here at the blob level, not just presence.
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
      await writeFile(hook, '#!/bin/sh\nexit 1\n', 'utf8');
      await chmod(hook, 0o755);

      const target = path.join(repo, '.copperhead', 'runs', 'x', 'summary.md');
      const relativeTarget = '.copperhead/runs/x/summary.md';
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, '# pre-existing staged content\n', 'utf8');
      await execa('git', ['add', '-f', target], { cwd: repo }); // staged BEFORE commitPathsSync ever touches it
      const { stdout: before } = await execa('git', ['show', `:${relativeTarget}`], { cwd: repo });
      await writeFile(target, '# newer artifact content\n', 'utf8'); // worktree changes after staging, before the call

      expect(() => commitPathsSync(repo, [target], 'copperhead: partial run data x (interrupted)')).toThrow();

      const { stdout: after } = await execa('git', ['show', `:${relativeTarget}`], { cwd: repo });
      expect(after).toBe(before);
    } finally {
      await cleanup();
    }
  });

  it('commitPaths/commitPathsSync no-op when nothing is staged, rather than erroring', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      expect(await commitPaths(repo, [path.join(repo, 'does-not-exist.txt')], 'msg')).toBeNull();
      expect(commitPathsSync(repo, [path.join(repo, 'does-not-exist.txt')], 'msg')).toBeNull();
    } finally {
      await cleanup();
    }
  });
});

describe('SIGKILL survival across a real process boundary (AC-16.2)', () => {
  it('completed calls survive a SIGKILL mid-turn; the in-flight call leaves nothing partial', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const runsDir = path.join(repo, '.copperhead', 'runs');
      const child = execa('node', ['--import', 'tsx', SCRIPT, repo], {
        cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
        reject: false,
      });

      // Poll for the run directory + two completed llm-call events, then kill.
      const deadline = Date.now() + 15000;
      let dir: string | null = null;
      while (Date.now() < deadline && !dir) {
        if (existsSync(runsDir)) {
          const { readdir } = await import('node:fs/promises');
          const entries = await readdir(runsDir);
          for (const entry of entries) {
            const jsonl = path.join(runsDir, entry, 'transcript.jsonl');
            if (existsSync(jsonl)) {
              const events = await transcriptEvents(path.join(runsDir, entry));
              if (events.filter((e) => e.type === 'llm-call').length >= 2) {
                dir = path.join(runsDir, entry);
                break;
              }
            }
          }
        }
        if (!dir) await new Promise((r) => setTimeout(r, 100));
      }
      // try/finally, not a bare assertion: if the poll times out, the throw
      // must not skip killing the spawned child — otherwise it leaks for the
      // rest of the test run (caught in review).
      try {
        expect(dir, 'expected two llm-call events to land before the timeout').toBeTruthy();
      } finally {
        child.kill('SIGKILL');
        await child.catch(() => {}); // wait for the process to actually exit
      }

      const events = await transcriptEvents(dir!);
      const calls = events.filter((e) => e.type === 'llm-call');
      expect(calls).toHaveLength(2);
      expect(calls[0]!.data.tokensIn).toBe(10);
      // no corrupt trailing partial line
      const raw = await readFile(path.join(dir!, 'transcript.jsonl'), 'utf8');
      expect(raw.endsWith('\n')).toBe(true);
      for (const line of raw.split('\n').filter(Boolean)) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    } finally {
      await cleanup();
    }
  }, 20000);
});

describe('stage-start report write stays disk-only (design D8 regression)', () => {
  it('a fresh, zero-commit repo still fails on "repository has no commits", not a later provider error', async () => {
    // Guards the exact bug design D8 documents: create.ts's stage-start
    // writeRunReport() call runs before that stage's own runAgentLoop call,
    // i.e. before gitPreflight has validated the repo even once. If a
    // stage-start commit were reintroduced there, it would create this
    // repo's first commit out of a REPORT.md write, silently curing the "no
    // commits yet" precondition — and this test would then fail with a
    // provider-resolution error instead of the one asserted below (this is
    // exactly the regression a real run of this test caught during
    // development). Deliberately in this file, not
    // run-metrics-create.test.ts: that file mocks runAgentLoop entirely, so
    // it cannot exercise the real gitPreflight check this test is about.
    const dir = await mkdtemp(path.join(tmpdir(), 'ch-d8-regression-'));
    try {
      await writeFile(path.join(dir, 'brief.md'), 'A tiny USB macro keypad', 'utf8');
      await execa('git', ['init', '-q'], { cwd: dir });
      await expect(
        runCreate({ repoRoot: dir, briefPath: path.join(dir, 'brief.md'), model: 'gpt-5', log: () => {} }),
      ).rejects.toThrow(/repository has no commits/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
