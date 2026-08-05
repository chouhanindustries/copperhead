import { statfs } from 'node:fs/promises';

/**
 * A run-blocking environment failure. Distinct from a mid-run error: nothing
 * has been written yet, so the message alone is the whole user experience.
 * The formatted message carries the reason, why copperhead refuses to run,
 * and concrete remedy steps — every CLI catch path prints err.message, so
 * embedding the explanation here means no call site needs special rendering.
 */
export class PreflightError extends Error {
  constructor(
    readonly reason: string,
    readonly why: string,
    readonly remedy: string[],
  ) {
    super(formatPreflightFailure(reason, why, remedy));
    this.name = 'PreflightError';
  }
}

export function formatPreflightFailure(reason: string, why: string, remedy: string[]): string {
  const steps = remedy.map((step, i) => `  ${i + 1}. ${step}`);
  return [reason, '', `why it failed: ${why}`, 'to fix:', ...steps].join('\n');
}

export function isNotFoundError(err: any): boolean {
  if (!err) return false;
  if (err.code === 'ENOENT') return true;
  if (process.platform === 'win32') {
    const msg = String(err.stderr || err.message || '');
    if (err.exitCode === 9009) {
      return (
        msg.includes('is not recognized') ||
        msg.includes('cannot find the path specified')
      );
    }
    if (err.exitCode === 1) {
      return msg.includes('is not recognized');
    }
  }
  return false;
}

/** Default minimum free space to start a run: 2 GiB. A create run emits gerbers,
 *  STEP, SVG renders and KiCad local history; 2 GiB is comfortably above a
 *  single board's output while still catching a nearly-full disk. */
export const DEFAULT_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

const gib = (n: number): string => `${(n / 1024 / 1024 / 1024).toFixed(1)} GiB`;

/**
 * Resolve the free-space threshold from a `COPPERHEAD_MIN_FREE_MB` value.
 *
 * An empty or whitespace-only value is treated as unset, not as zero:
 * `Number('')` is `0`, so parsing the raw value would turn an env var that was
 * declared but never filled in (a blank line in `.env`, an unset CI variable)
 * into a 0-byte threshold, silently disabling the check this module exists for.
 * Anything else unparseable, negative, or non-finite also falls back to
 * `DEFAULT_MIN_FREE_BYTES`, which is exported for callers that need it.
 */
export function resolveMinFreeBytes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MIN_FREE_BYTES;
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb < 0) return DEFAULT_MIN_FREE_BYTES;
  return mb * 1024 * 1024;
}

/**
 * Free bytes available to this (unprivileged) user on the filesystem holding
 * `dir`, or null when the platform/Node build cannot report it — callers treat
 * null as "unknown" and skip the check rather than blocking a legitimate run.
 */
export async function freeDiskBytes(dir: string): Promise<number | null> {
  try {
    const fs = await statfs(dir);
    return fs.bavail * fs.bsize;
  } catch {
    return null;
  }
}

/**
 * Refuse to start when free disk is below `minFreeBytes` (4.1). A long run can
 * fill the disk mid-stage — gerbers/STEP/SVG plus unbounded KiCad local history
 * — and then fail with an opaque `ENOSPC` after doing real, expensive work. A
 * preflight fails fast with an actionable message instead. An unknown reading
 * (unsupported platform) skips the check.
 */
export async function assertDiskSpace(dir: string, minFreeBytes = DEFAULT_MIN_FREE_BYTES): Promise<void> {
  const free = await freeDiskBytes(dir);
  if (free === null || free >= minFreeBytes) return;
  throw new PreflightError(
    `not enough free disk space to start (${gib(free)} available, ${gib(minFreeBytes)} required)`,
    'a create run writes fabrication outputs and KiCad local history and can fill the disk mid-stage, failing with an opaque ENOSPC only after doing real work',
    [
      'free up space on the volume holding this repo',
      'or lower the threshold with COPPERHEAD_MIN_FREE_MB (e.g. COPPERHEAD_MIN_FREE_MB=500)',
      'then re-run',
    ],
  );
}
