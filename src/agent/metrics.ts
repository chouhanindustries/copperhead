import { mkdir, open, rename } from 'node:fs/promises';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { ExitPath } from './transcript.js';

/**
 * Live, whole-run cost snapshot, current for the entire lifetime of a run
 * (change flush-run-metrics-incrementally). Deliberately its own type rather
 * than a reuse of `RunStats`/`ExitPath`: those are terminal-only, and an
 * in-progress run has no terminal exit path yet. `status` is `'running'` for
 * the run's whole healthy duration, `'stalled'` only when the loop's own
 * stall detector actually fires, and a real `ExitPath` once the run reaches
 * a terminal branch and writes its last snapshot — never a placeholder
 * default for "not finished yet" (design D2).
 */
export interface LiveMetrics {
  runId: string;
  status: 'running' | 'stalled' | ExitPath;
  turn: number;
  maxTurns: number;
  tokensIn: number;
  tokensOut: number;
  cacheHits: number;
  startedAt: string;
  lastUpdateAt: string;
}

function metricsPath(dir: string): string {
  return path.join(dir, 'metrics.json');
}

function serialize(data: LiveMetrics): string {
  return JSON.stringify(data, null, 2) + '\n';
}

/**
 * Atomic write (temp file + fsync + rename) so a reader never observes a
 * partially-written metrics.json, called after every `llm-call` event and
 * from the loop's existing heartbeat so the file keeps advancing even during
 * a single long or hung call (design D3/D4).
 */
export async function writeLiveMetrics(dir: string, data: LiveMetrics): Promise<void> {
  await mkdir(dir, { recursive: true });
  const target = metricsPath(dir);
  const tmp = `${target}.tmp-${process.pid}`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(serialize(data), 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, target);
}

/**
 * Synchronous twin of {@link writeLiveMetrics}, used only from the SIGINT/
 * SIGTERM handler (design D5): a signal handler must complete within one
 * synchronous tick before another registered listener can call
 * `process.exit()` out from under it, so it cannot `await` anything.
 */
export function writeLiveMetricsSync(dir: string, data: LiveMetrics): void {
  mkdirSync(dir, { recursive: true });
  const target = metricsPath(dir);
  const tmp = `${target}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, serialize(data));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
}
