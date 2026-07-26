import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { withTimeout, TurnTimeoutError, parseDiagnosis, diagnoseStageFailure } from '../src/agent/recovery.js';
import { CachingProvider } from '../src/agent/response-cache.js';
import type { Msg, Provider, ToolSchema, Turn } from '../src/agent/types.js';

function turn(text: string): Turn {
  return { text, toolCalls: [], usage: { inputTokens: 10, outputTokens: 20 } };
}

/** Records how many times chat() actually reached the model. */
class CountingProvider implements Provider {
  readonly name = 'counting';
  calls = 0;
  constructor(private readonly reply: (n: number) => Turn) {}
  async chat(): Promise<Turn> {
    return this.reply(++this.calls);
  }
}

const msgs: Msg[] = [{ role: 'user', content: 'hi' }];
const tools: ToolSchema[] = [];

describe('withTimeout (turn watchdog)', () => {
  it('returns the value when the call finishes in time', async () => {
    expect(await withTimeout(() => Promise.resolve(42), 1000)).toBe(42);
  });

  it('rejects with TurnTimeoutError and fires onTimeout when the deadline passes', async () => {
    let cleaned = false;
    const hang = new Promise<number>(() => {}); // never resolves
    await expect(withTimeout(() => hang, 30, () => { cleaned = true; })).rejects.toBeInstanceOf(TurnTimeoutError);
    expect(cleaned).toBe(true);
  });

  it('disables the watchdog when ms <= 0 (awaits the call)', async () => {
    expect(await withTimeout(() => Promise.resolve('ok'), 0)).toBe('ok');
  });
});

describe('parseDiagnosis', () => {
  it('parses a retry verdict with guidance, even wrapped in prose', async () => {
    const d = parseDiagnosis('Sure — here is my call:\n{"verdict":"retry","reason":"dropped edit","guidance":"apply the edit"}\ndone');
    expect(d.verdict).toBe('retry');
    expect(d.reason).toBe('dropped edit');
    expect(d.guidance).toBe('apply the edit');
  });

  it('parses an abort verdict and ignores guidance', () => {
    const d = parseDiagnosis('{"verdict":"abort","reason":"missing inputs","guidance":"n/a"}');
    expect(d.verdict).toBe('abort');
    expect(d.guidance).toBeUndefined();
  });

  it('fails safe to abort on non-JSON or missing verdict', () => {
    expect(parseDiagnosis('no json here').verdict).toBe('abort');
    expect(parseDiagnosis(null).verdict).toBe('abort');
    expect(parseDiagnosis('{"reason":"x"}').verdict).toBe('abort');
  });

  // An aborted stage ends the run, so reading a retry as an abort is not a
  // parsing nit: it discards a recovery the model just asked for.
  it('finds the verdict past an unbalanced brace in the prose', () => {
    const d = parseDiagnosis(
      'The stage emitted a literal { in its output.\n' +
        '{"verdict":"retry","reason":"dropped edit","guidance":"apply the edit"}',
    );
    expect(d.verdict).toBe('retry');
    expect(d.reason).toBe('dropped edit');
    expect(d.guidance).toBe('apply the edit');
  });

  it('skips a preamble object that carries no verdict', () => {
    const d = parseDiagnosis('{"note":"thinking"}\n{"verdict":"retry","reason":"real reason"}');
    expect(d.verdict).toBe('retry');
    expect(d.reason).toBe('real reason');
  });

  it('still aborts when no object anywhere carries a verdict', () => {
    const d = parseDiagnosis('{"note":"thinking"}\n{"reason":"still no verdict"}');
    expect(d.verdict).toBe('abort');
    expect(d.reason).toBe('diagnosis was not valid JSON');
  });

  it('does not treat a brace inside a JSON string as structure', () => {
    const d = parseDiagnosis('{"verdict":"retry","reason":"x","guidance":"call it with {\\"path\\": \\"a.md\\"}"}');
    expect(d.verdict).toBe('retry');
    expect(d.guidance).toBe('call it with {"path": "a.md"}');
  });
});

describe('diagnoseStageFailure', () => {
  it('asks the model with no tools and returns the parsed verdict', async () => {
    let sawTools: ToolSchema[] | undefined;
    const provider: Provider = {
      name: 'fake',
      async chat(_m, t) {
        sawTools = t;
        return turn('{"verdict":"retry","reason":"looks transient","guidance":"try again"}');
      },
    };
    const d = await diagnoseStageFailure(provider, {
      stageName: 'schematic',
      stageGoal: 'build it',
      failure: 'contract not met',
      excerpt: '[assistant] ...',
      attempt: 1,
      maxAttempts: 3,
    });
    expect(d.verdict).toBe('retry');
    expect(sawTools).toEqual([]); // diagnosis is a tool-less turn
  });

  it('fails safe to abort when the provider throws', async () => {
    const provider: Provider = {
      name: 'boom',
      async chat() {
        throw new Error('no key');
      },
    };
    const d = await diagnoseStageFailure(provider, {
      stageName: 's', stageGoal: 'g', failure: 'f', excerpt: '', attempt: 1, maxAttempts: 2,
    });
    expect(d.verdict).toBe('abort');
  });
});

describe('CachingProvider', () => {
  it('caches a response and replays it (no second model call), reporting zero usage', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-cache-'));
    try {
      const inner = new CountingProvider(() => turn('answer'));
      const cached = new CachingProvider(inner, dir);
      const first = await cached.chat(msgs, tools);
      const second = await cached.chat(msgs, tools);
      expect(first.text).toBe('answer');
      expect(second.text).toBe('answer');
      expect(inner.calls).toBe(1); // second served from cache
      expect(second.usage).toEqual({ inputTokens: 0, outputTokens: 0 }); // replay costs nothing
      expect(existsSync(path.join(dir, '.gitignore'))).toBe(true); // cache stays out of git
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('misses (calls the model again) when the conversation differs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-cache-'));
    try {
      const inner = new CountingProvider((n) => turn(`answer ${n}`));
      const cached = new CachingProvider(inner, dir);
      await cached.chat(msgs, tools);
      await cached.chat([{ role: 'user', content: 'different' }], tools);
      expect(inner.calls).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
