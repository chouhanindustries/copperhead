export interface RetryOpts {
  retries?: number;
  baseMs?: number;
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (attempt: number, err: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}

export function isRateLimit(err: unknown): boolean {
  const status = (err as { status?: number; statusCode?: number })?.status
    ?? (err as { statusCode?: number })?.statusCode;
  return status === 429;
}

export interface SessionLimit {
  /** The reset moment exactly as the provider stated it (e.g. "1:40pm"), or null
   *  when the message named a limit but no parseable time. */
  resetsAt: string | null;
}

/**
 * Detect a saved-login SESSION / USAGE limit (claude-code, codex), distinct from
 * an HTTP 429 rate limit and from a code bug (2.4, I13). It is not a transient
 * blip to back off on: it names its own reset time and clears only then. Because
 * every completed turn is already in `.copperhead/llm-cache/`, re-running after
 * the reset replays them at ~0 tokens and resumes in place — so the right
 * handling is a schedulable pause with the reset time surfaced, not a bare
 * "provider error". Returns the parsed reset time (verbatim) or null when the
 * error is not a session/usage limit.
 */
export function sessionLimit(err: unknown): SessionLimit | null {
  const status = (err as { status?: number; statusCode?: number })?.status
    ?? (err as { statusCode?: number })?.statusCode;
  if (status === 429) return null; // a real rate limit: handled by backoff, not a pause
  const msg = (err as Error)?.message ?? '';
  if (!/(session|usage|weekly)\s+limit|hit your .*limit|reached your usage|limit .*reset/i.test(msg)) {
    return null;
  }
  // "resets 1:40pm", "resets at 1:40 pm", "reset at 13:40" — capture the clock text.
  const reset = msg.match(/reset[s]?(?:\s+at)?\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?)/i);
  return { resetsAt: reset?.[1]?.trim() ?? null };
}

/** Exponential backoff ×N for rate limits (SPEC §4.5). */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseMs = opts.baseMs ?? 1000;
  const isRetryable = opts.isRetryable ?? isRateLimit;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === retries) throw err;
      opts.onRetry?.(attempt + 1, err);
      await sleep(baseMs * 2 ** attempt);
    }
  }
  throw lastErr;
}
