import { describe, expect, it } from "vitest";
import { withBackoff, withTimeout, TimeoutError } from "../adapters/resilience";

function rateLimited(): Error {
  const err = new Error("429") as Error & { statusCode: number };
  err.statusCode = 429;
  return err;
}

describe("withBackoff (AC-12.1)", () => {
  it("retries a 429 up to 3 times with exponential delays, then fails", async () => {
    const delays: number[] = [];
    let attempts = 0;
    await expect(
      withBackoff(
        async () => {
          attempts++;
          throw rateLimited();
        },
        { sleep: async (ms) => void delays.push(ms) },
      ),
    ).rejects.toThrow("429");
    expect(attempts).toBe(4);
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it("succeeds after a transient 503", async () => {
    let attempts = 0;
    const result = await withBackoff(
      async () => {
        attempts++;
        if (attempts < 3) {
          const err = new Error("503") as Error & { statusCode: number };
          err.statusCode = 503;
          throw err;
        }
        return "ok";
      },
      { sleep: async () => {} },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("does not retry non-retryable errors", async () => {
    let attempts = 0;
    await expect(
      withBackoff(
        async () => {
          attempts++;
          throw new Error("400 bad request");
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow("400");
    expect(attempts).toBe(1);
  });

  it("recognizes SDK-style error class names", async () => {
    let attempts = 0;
    class TooManyRequestsError extends Error {
      constructor() {
        super("too many requests");
        this.name = "TooManyRequestsError";
      }
    }
    await expect(
      withBackoff(
        async () => {
          attempts++;
          throw new TooManyRequestsError();
        },
        { retries: 1, sleep: async () => {} },
      ),
    ).rejects.toThrow("too many requests");
    expect(attempts).toBe(2);
  });
});

describe("withTimeout (AC-1.3)", () => {
  it("throws a typed TimeoutError when work exceeds the deadline", async () => {
    const never = new Promise(() => {});
    await expect(withTimeout(never, 10, "poll")).rejects.toThrow(TimeoutError);
  });

  it("resolves when work completes in time", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, "poll")).resolves.toBe(42);
  });
});
