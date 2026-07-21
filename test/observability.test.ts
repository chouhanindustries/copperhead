import { describe, it, expect } from 'vitest';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { runAgentLoop, type RunOptions } from '../src/agent/loop.js';
import type { Provider, Turn } from '../src/agent/types.js';
import { InteractiveRenderer } from '../src/agent/render.js';
import { tempFixtureRepo } from './helpers.js';

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

const spin = (id: string): Turn => ({
  text: 'still working',
  toolCalls: [{ id, name: 'bogus_tool', args: {} }],
  usage: { inputTokens: 1000, outputTokens: 200 },
});

const finishTurn = (outcome: 'done' | 'refuse', summary: string): Turn => ({
  text: null,
  toolCalls: [{ id: 'fin', name: 'finish', args: { outcome, summary } }],
  usage: { inputTokens: 500, outputTokens: 100 },
});

function loopOpts(repo: string, provider: Provider, lines: string[], extra: Partial<RunOptions> = {}): RunOptions {
  return {
    repoRoot: repo,
    request: 'observability test run',
    model: 'gpt-5',
    provider,
    log: (l) => lines.push(l),
    meta: { command: 'do', modelSource: 'flag', version: '9.9.9', kicadCliVersion: '9.0.0' },
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

describe('run metadata on the three surfaces (tasks 3.2/3.4)', () => {
  it('run-start carries the full block and the CLI header precedes turn 1 (AC-8.1/8.4)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const lines: string[] = [];
      const res = await runAgentLoop(loopOpts(repo, new ScriptedProvider([spin('a')]), lines, { maxTurns: 2 }));

      const events = await transcriptEvents(res.transcriptDir);
      const start = events.find((e) => e.type === 'run-start')!.data;
      // pre-existing field names survive (AC-8.1)
      expect(start.request).toBe('observability test run');
      expect(start.model).toBe('gpt-5');
      expect(start.provider).toBe('scripted');
      expect(start.modelSource).toBe('flag');
      expect(start.command).toBe('do');
      expect((start.versions as Record<string, unknown>).copperhead).toBe('9.9.9');
      expect((start.versions as Record<string, unknown>).kicadCli).toBe('9.0.0');
      expect((start.config as Record<string, unknown>).schematic).toBeNull();
      expect((start.config as Record<string, unknown>).maxTurns).toBe(2);
      expect((start.git as Record<string, unknown>).commit).toBeTruthy();

      // header before the first turn marker, then markers with cumulative tokens
      const headerIdx = lines.findIndex((l) => l.startsWith('copperhead v9.9.9'));
      const turn1Idx = lines.findIndex((l) => l.startsWith('[turn 1/2'));
      expect(headerIdx).toBeGreaterThanOrEqual(0);
      expect(turn1Idx).toBeGreaterThan(headerIdx);
      expect(lines).toContain('[turn 1/2 · 0 in / 0 out]');
      expect(lines).toContain('[turn 2/2 · 1.0k in / 200 out]');
      // plain mode: zero ANSI escapes (AC-8.9)
      expect(lines.join('\n')).not.toContain('\x1b');

      const summary = await readFile(path.join(res.transcriptDir, 'summary.md'), 'utf8');
      expect(summary).toContain('## Environment');
      expect(summary).toContain('schematic null');
    } finally {
      await cleanup();
    }
  });
});

describe('exit paths and run-end addenda (task 4.6)', () => {
  it('turn-budget exhaustion is machine-readable (AC-8.5)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const lines: string[] = [];
      const res = await runAgentLoop(loopOpts(repo, new ScriptedProvider([spin('a')]), lines, { maxTurns: 2 }));
      expect(res.outcome).toBe('failure');
      expect(res.exitPath).toBe('turn-budget-exhausted');

      const events = await transcriptEvents(res.transcriptDir);
      const end = events.find((e) => e.type === 'run-end')!.data;
      expect(end.exitPath).toBe('turn-budget-exhausted');
      expect(end.turnsUsed).toBe(2);
      expect(end.maxTurns).toBe(2);
      expect((end.perTurn as unknown[]).length).toBe(2);
      expect(end.tokensIn).toBe(2000);
      expect(end.tokensOut).toBe(400);

      const summary = await readFile(path.join(res.transcriptDir, 'summary.md'), 'utf8');
      expect(summary).toContain('## Run stats');
      expect(summary).toContain('turn-budget-exhausted');
      expect(summary).toContain('**Turns:** 2 / 2');
      // final outcome line is last
      expect(lines[lines.length - 1]).toContain('turn-budget-exhausted');
    } finally {
      await cleanup();
    }
  });

  it('a refusal records exitPath refused (AC-8.5)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const provider = new ScriptedProvider([finishTurn('refuse', 'violates the sleep-current budget')]);
      const res = await runAgentLoop(loopOpts(repo, provider, [], { maxTurns: 3 }));
      expect(res.outcome).toBe('refused');
      expect(res.exitPath).toBe('refused');
      const events = await transcriptEvents(res.transcriptDir);
      expect(events.find((e) => e.type === 'run-end')!.data.exitPath).toBe('refused');
    } finally {
      await cleanup();
    }
  });

  it('commit failure is a reported outcome, not a crash (AC-8.6)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      // docs/ must exist for the changelog write; commit it so preflight is clean
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(path.join(repo, 'docs', 'DECISIONS.md'), '# Decisions\n', 'utf8');
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'docs'], { cwd: repo });
      // a failing pre-commit hook makes the end-of-run `git commit` exit non-zero
      const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
      await writeFile(hook, '#!/bin/sh\necho "check failed" >&2\nexit 1\n', 'utf8');
      await chmod(hook, 0o755);

      const lines: string[] = [];
      const provider = new ScriptedProvider([finishTurn('done', 'all good')]);
      // must resolve, not reject: no unhandled stack trace (AC-8.6)
      const res = await runAgentLoop(loopOpts(repo, provider, lines, { maxTurns: 3 }));
      expect(res.outcome).toBe('failure');
      expect(res.exitPath).toBe('commit-failed');

      const summary = await readFile(path.join(res.transcriptDir, 'summary.md'), 'utf8');
      expect(summary).toContain('commit-failed');
      expect(summary).toContain('commit failed:');
      // rolled back per the snapshot contract
      const { stdout: status } = await execa('git', ['status', '--porcelain'], { cwd: repo });
      expect(status).toBe('');
    } finally {
      await cleanup();
    }
  });
});

describe('redaction of metadata surfaces (task 6.1)', () => {
  it('an sk- secret in a metadata field is redacted on both surfaces (AC-8.10)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const secret = 'sk-test1234567890abcdef';
      const res = await runAgentLoop(
        loopOpts(repo, new ScriptedProvider([spin('a')]), [], {
          maxTurns: 1,
          meta: { command: 'do', modelSource: 'flag', version: secret, kicadCliVersion: '9.0.0' },
        }),
      );
      const transcript = await readFile(path.join(res.transcriptDir, 'transcript.jsonl'), 'utf8');
      const summary = await readFile(path.join(res.transcriptDir, 'summary.md'), 'utf8');
      expect(transcript).not.toContain(secret);
      expect(summary).not.toContain(secret);
      expect(transcript).toContain('[REDACTED]');
      expect(summary).toContain('[REDACTED]');
    } finally {
      await cleanup();
    }
  });
});

describe('interactive renderer (task 5.7)', () => {
  it('redraws a status line in place and restores the cursor on finish (AC-8.8)', () => {
    let written = '';
    const fake = { write: (c: string) => (written += c), columns: 80 };
    const r = new InteractiveRenderer(fake);

    r.turnStart(1, 40, 0, 0);
    expect(written).toContain('\x1b[?25l'); // cursor hidden
    expect(written).toContain('turn 1/40');

    r.status('thinking');
    expect(written).toContain('thinking');

    r.log('hello above the status line');
    expect(written).toContain('\r\x1b[2K'); // clear-line before printing above
    expect(written).toContain('hello above the status line\n');

    r.finish('done · 1s');
    expect(written).toContain('done · 1s\n');
    expect(written).toContain('\x1b[?25h'); // cursor restored (also the Ctrl-C path)

    const before = written;
    r.log('after finish is dropped');
    expect(written).toBe(before);
  });
});
