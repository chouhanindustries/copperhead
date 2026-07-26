import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sessionLimit, isRateLimit } from '../src/util/retry.js';
import {
  assertDiskSpace,
  DEFAULT_MIN_FREE_BYTES,
  freeDiskBytes,
  PreflightError,
  resolveMinFreeBytes,
} from '../src/util/preflight.js';

describe('sessionLimit (2.4 / I13 — a schedulable pause, not a bug)', () => {
  it('detects a saved-login session limit and extracts the reset time', () => {
    const err = new Error("provider error: You've hit your session limit · resets 1:40pm");
    const limit = sessionLimit(err);
    expect(limit).not.toBeNull();
    expect(limit!.resetsAt).toBe('1:40pm');
  });

  it('recognizes a usage limit even without a parseable reset time', () => {
    const limit = sessionLimit(new Error('You have reached your usage limit for now'));
    expect(limit).not.toBeNull();
    expect(limit!.resetsAt).toBeNull();
  });

  it('does NOT treat a 429 rate limit as a session limit (it is handled by backoff)', () => {
    const err = Object.assign(new Error('rate limited, session limit-ish wording'), { status: 429 });
    expect(sessionLimit(err)).toBeNull();
    expect(isRateLimit(err)).toBe(true);
  });

  it('does NOT match an ordinary provider/code error', () => {
    expect(sessionLimit(new Error('ECONNRESET'))).toBeNull();
    expect(sessionLimit(new Error('unexpected token in JSON'))).toBeNull();
  });
});

describe('disk-space preflight (4.1)', () => {
  let dir: string;

  it('reports a positive free-byte reading for a real directory', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'copperhead-disk-test-'));
    try {
      const free = await freeDiskBytes(dir);
      // Either a real positive number, or null on a platform that cannot report it.
      expect(free === null || free > 0).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('passes with a 0-byte threshold and throws a PreflightError with an impossibly high one', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'copperhead-disk-test-'));
    try {
      await expect(assertDiskSpace(dir, 0)).resolves.toBeUndefined();
      // Only assert the throw when the platform actually reports free space;
      // a null reading legitimately skips the check.
      if ((await freeDiskBytes(dir)) !== null) {
        await expect(assertDiskSpace(dir, Number.MAX_SAFE_INTEGER)).rejects.toBeInstanceOf(PreflightError);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveMinFreeBytes (COPPERHEAD_MIN_FREE_MB)', () => {
  it('uses the default when the variable is unset', () => {
    expect(resolveMinFreeBytes(undefined)).toBe(DEFAULT_MIN_FREE_BYTES);
  });

  it('treats an empty or blank value as unset, not as zero', () => {
    // Number('') is 0, so parsing the raw value would set a 0-byte threshold
    // and silently disable the check. A declared-but-unfilled variable is
    // exactly what a blank .env line or an unset CI variable produces.
    for (const raw of ['', ' ', '   ', '\t', '\n']) {
      expect(resolveMinFreeBytes(raw), JSON.stringify(raw)).toBe(DEFAULT_MIN_FREE_BYTES);
    }
  });

  it('falls back on values that are not a usable number', () => {
    for (const raw of ['abc', '-1', 'Infinity', 'NaN', '1,000']) {
      expect(resolveMinFreeBytes(raw), raw).toBe(DEFAULT_MIN_FREE_BYTES);
    }
  });

  it('converts a valid value from MiB to bytes', () => {
    expect(resolveMinFreeBytes('500')).toBe(500 * 1024 * 1024);
    expect(resolveMinFreeBytes('  500  ')).toBe(500 * 1024 * 1024);
    expect(resolveMinFreeBytes('0.5')).toBe(0.5 * 1024 * 1024);
  });

  it('still honours an explicit 0 as an opt-out', () => {
    // Distinguishable from the empty case above, which is the point: an
    // operator can still turn the check off on purpose.
    expect(resolveMinFreeBytes('0')).toBe(0);
  });
});
