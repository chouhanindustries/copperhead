// Timeout and backoff wrappers for unreliable upstream calls.
// POLL_TIMEOUT_MS and the backoff schedule come from the intake SPEC.

export const POLL_TIMEOUT_MS = 90_000;
export const POLL_INTERVAL_MS = 2_000;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_FACTOR = 2;
export const MAX_RETRIES = 3;

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/** Reject with TimeoutError if `work` does not settle within `ms`. */
export async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label} exceeded ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface BackoffOptions {
  retries?: number;
  baseMs?: number;
  factor?: number;
  /** Decide whether an error is retryable (default: 429/503-shaped errors). */
  isRetryable?: (error: unknown) => boolean;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultRetryable(error: unknown): boolean {
  const status =
    typeof error === "object" && error !== null && "statusCode" in error
      ? (error as { statusCode: unknown }).statusCode
      : undefined;
  if (status === 429 || status === 503) return true;
  const name = error instanceof Error ? error.name : "";
  return name === "TooManyRequestsError" || name === "ServiceUnavailableError";
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `attempt`, retrying retryable failures with exponential backoff
 * (base 1 s, factor 2, max 3 retries). Non-retryable errors propagate
 * immediately; the last retryable error propagates after the retries
 * are exhausted.
 */
export async function withBackoff<T>(
  attempt: () => Promise<T>,
  options: BackoffOptions = {},
): Promise<T> {
  const retries = options.retries ?? MAX_RETRIES;
  const baseMs = options.baseMs ?? BACKOFF_BASE_MS;
  const factor = options.factor ?? BACKOFF_FACTOR;
  const isRetryable = options.isRetryable ?? defaultRetryable;
  const sleep = options.sleep ?? realSleep;

  let lastError: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || i === retries) throw error;
      await sleep(baseMs * factor ** i);
    }
  }
  throw lastError;
}
