import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChatOpts, Msg, Provider, ToolSchema, Turn } from './types.js';

/**
 * Wraps a provider so each turn's `(messages, tools) -> Turn` is written to disk
 * and replayed on an identical later call. This makes the pipeline cheap and
 * fast to recover: a stage that is retried after a transient failure (a timed-out
 * turn, a crash, an auto-retry) replays the responses it already paid for, from
 * turn 1 up to the point where the inputs first diverge, instead of re-calling
 * the model. When a retry deliberately changes the prompt (e.g. diagnosis
 * guidance is appended), the input hash changes and the model is called fresh —
 * so caching never pins a run to a stale, failing response.
 *
 * Best-effort by construction: a cache miss or any I/O error falls through to the
 * live provider, and a hit reports zero token usage (the real spend was zero).
 * The key is a content hash of the full message history and the advertised tool
 * names, so any change to the conversation or available tools is a fresh call.
 */
export class CachingProvider implements Provider {
  readonly name: string;
  private hits = 0;

  /** Turns served from the on-disk cache so far (5.2: per-stage cache-hit%). */
  get cacheHits(): number {
    return this.hits;
  }

  constructor(
    private readonly inner: Provider,
    private readonly dir: string,
    private readonly log?: (s: string) => void,
    /** The concrete model id this run resolved to (e.g. `claude-code:opus`), used
     *  in the cache key so switching model on the same repo does not replay the
     *  other model's cached turns (F6). Falls back to the provider family name. */
    private readonly modelId?: string,
  ) {
    this.name = inner.name;
  }

  private keyFor(messages: Msg[], tools: ToolSchema[]): string {
    return createHash('sha256')
      .update(JSON.stringify({ model: this.modelId ?? this.name, messages, tools: tools.map((t) => t.name) }))
      .digest('hex');
  }

  async chat(messages: Msg[], tools: ToolSchema[], opts?: ChatOpts): Promise<Turn> {
    const file = path.join(this.dir, `${this.keyFor(messages, tools)}.json`);
    if (existsSync(file)) {
      try {
        const cached = JSON.parse(await readFile(file, 'utf8')) as Turn;
        this.hits++;
        this.log?.(`llm-cache: replayed a cached response (hit #${this.hits}, no tokens spent)`);
        // Report zero usage: replaying a cached turn costs nothing.
        return { ...cached, usage: { inputTokens: 0, outputTokens: 0 } };
      } catch {
        // corrupt/partial cache file — fall through and regenerate
      }
    }
    // Strict replay mode (deterministic e2e tests): a miss is a divergence from
    // the recording, not something to paper over with a live call. Throw with
    // the key so the missing/expected cache entry is directly greppable.
    if (process.env.COPPERHEAD_CACHE_ONLY === '1') {
      throw new Error(
        `llm-cache: cache-only mode is on (COPPERHEAD_CACHE_ONLY=1) but this turn has no cached response ` +
          `(expected ${path.basename(file)} in ${this.dir}); the replay diverged from the recording`,
      );
    }
    const turn = await this.inner.chat(messages, tools, opts);
    try {
      await mkdir(this.dir, { recursive: true });
      // Keep the cache out of git entirely (and out of failed-run stashes): a
      // `*` .gitignore in the cache dir hides every entry, so the cache persists
      // across runs without ever dirtying the tree.
      const ignore = path.join(this.dir, '.gitignore');
      if (!existsSync(ignore)) await writeFile(ignore, '*\n', 'utf8');
      await writeFile(file, JSON.stringify(turn), 'utf8');
    } catch {
      // best-effort: caching must never break a run
    }
    return turn;
  }

  async close(): Promise<void> {
    await this.inner.close?.();
  }
}
