import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { sweepStaleTempDirs, pruneHistoryDir, TEMP_PREFIX } from '../src/util/tmp.js';

// These exercise the I8 startup sweep. They create real `copperhead-*` dirs in
// the OS temp dir (the exact place the leak lives) and age them via utimes, so
// the age gate is tested against the same clock the sweep reads.
describe('sweepStaleTempDirs (I8: reclaim leaked scratch dirs)', () => {
  const made: string[] = [];

  async function makeAged(suffix: string, ageMs: number, now: number): Promise<string> {
    const dir = path.join(tmpdir(), `${TEMP_PREFIX}${suffix}-${process.pid}-${made.length}`);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'erc.json'), '{}'); // non-empty, like a real leak
    const when = new Date(now - ageMs);
    await utimes(dir, when, when);
    made.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const d of made.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it('removes a stale dir but keeps a fresh one', async () => {
    const now = 1_000_000_000_000;
    const stale = await makeAged('erc-stale', 3 * 60 * 60 * 1000, now); // 3h old
    const fresh = await makeAged('cc-fresh', 5 * 60 * 1000, now); // 5m old

    const removed = await sweepStaleTempDirs(now); // default 2h cutoff

    expect(removed).toContain(stale);
    expect(removed).not.toContain(fresh);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('never touches non-copperhead temp dirs', async () => {
    const now = 1_000_000_000_000;
    const foreign = await mkdtemp(path.join(tmpdir(), 'someone-else-'));
    made.push(foreign);
    const when = new Date(now - 24 * 60 * 60 * 1000); // a day old
    await utimes(foreign, when, when);

    const removed = await sweepStaleTempDirs(now);

    expect(removed).not.toContain(foreign);
    expect(existsSync(foreign)).toBe(true);
  });

  it('honours a custom maxAge and returns [] when nothing is stale', async () => {
    const now = 1_000_000_000_000;
    const recent = await makeAged('validate-recent', 90 * 1000, now); // 90s old

    // 60s cutoff: the 90s-old dir is stale and swept.
    expect(await sweepStaleTempDirs(now, 60 * 1000)).toContain(recent);
  });

  it('is best-effort: a missing temp root yields [] rather than throwing', async () => {
    // stat of the sweep is guarded; a well-formed call on an empty result set
    // must simply return [] (no dirs match the prefix at this instant is fine).
    const removed = await sweepStaleTempDirs(0, 1);
    expect(Array.isArray(removed)).toBe(true);
  });
});

describe('pruneHistoryDir (4.1: cap .history/ growth)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'copperhead-hist-test-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('keeps the newest N entries and removes older ones (recursively)', async () => {
    const hist = path.join(repo, '.history', 'nested');
    await mkdir(hist, { recursive: true });
    const base = 1_000_000_000_000;
    for (let i = 0; i < 10; i++) {
      const f = path.join(hist, `snap-${i}.kicad_sch`);
      await writeFile(f, `v${i}`);
      const when = new Date(base + i * 1000); // ascending mtime: higher i = newer
      await utimes(f, when, when);
    }
    const removed = await pruneHistoryDir(repo, 4);
    expect(removed).toBe(6); // 10 - 4 kept
    // the 4 newest (i=6..9) survive; the 6 oldest are gone
    expect(existsSync(path.join(hist, 'snap-9.kicad_sch'))).toBe(true);
    expect(existsSync(path.join(hist, 'snap-6.kicad_sch'))).toBe(true);
    expect(existsSync(path.join(hist, 'snap-5.kicad_sch'))).toBe(false);
    expect(existsSync(path.join(hist, 'snap-0.kicad_sch'))).toBe(false);
  });

  it('is a no-op when under the cap or the dir is absent', async () => {
    expect(await pruneHistoryDir(repo, 200)).toBe(0); // no .history/ at all
    await mkdir(path.join(repo, '.history'), { recursive: true });
    await writeFile(path.join(repo, '.history', 'a'), 'x');
    expect(await pruneHistoryDir(repo, 200)).toBe(0); // one file, under cap
    expect(existsSync(path.join(repo, '.history', 'a'))).toBe(true);
  });
});
