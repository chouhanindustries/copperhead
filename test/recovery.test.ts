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

  // Strict replay mode (COPPERHEAD_CACHE_ONLY=1, used by the deterministic e2e
  // replay test): a miss is a divergence from the recording and must throw
  // instead of falling through to a live provider call.
  it('cache-only mode: a miss throws (naming the expected cache entry) without touching the model', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-cache-'));
    const prev = process.env.COPPERHEAD_CACHE_ONLY;
    process.env.COPPERHEAD_CACHE_ONLY = '1';
    try {
      const inner = new CountingProvider(() => turn('live answer'));
      const cached = new CachingProvider(inner, dir);
      await expect(cached.chat(msgs, tools)).rejects.toThrow(/cache-only mode.*no cached response/);
      await expect(cached.chat(msgs, tools)).rejects.toThrow(/[0-9a-f]{64}\.json/); // the greppable key
      expect(inner.calls).toBe(0); // the live provider was never reached
    } finally {
      if (prev === undefined) delete process.env.COPPERHEAD_CACHE_ONLY;
      else process.env.COPPERHEAD_CACHE_ONLY = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('cache-only mode: hits are still served from disk with zero usage', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-cache-'));
    const prev = process.env.COPPERHEAD_CACHE_ONLY;
    try {
      const inner = new CountingProvider(() => turn('recorded answer'));
      const cached = new CachingProvider(inner, dir);
      await cached.chat(msgs, tools); // record with the mode off
      process.env.COPPERHEAD_CACHE_ONLY = '1';
      const replayed = await cached.chat(msgs, tools);
      expect(replayed.text).toBe('recorded answer');
      expect(replayed.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
      expect(inner.calls).toBe(1); // only the recording call reached the model
    } finally {
      if (prev === undefined) delete process.env.COPPERHEAD_CACHE_ONLY;
      else process.env.COPPERHEAD_CACHE_ONLY = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
