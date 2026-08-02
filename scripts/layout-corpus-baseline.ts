#!/usr/bin/env tsx
import { readdir, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBoard } from '../src/kicad/pcb.js';
import { computeLayoutMetrics } from '../src/kicad/layout-metrics.js';

/**
 * Record the layout-score distribution of a corpus of real boards, so a per-run
 * score has something to be a percentile of and so a scorer change shows up as a
 * diff in a committed file rather than as nothing at all.
 *
 * Default corpus is the KiCad demo set that ships with the installed KiCad
 * (`/usr/share/kicad/demos`, 17 projects). That directory is a KiCad install
 * artifact, not a Copperhead dependency: when it is absent this script says so
 * and exits 0, and the corpus test skips for the same reason.
 *
 *   npm run layout:corpus                  # default corpus, default output
 *   npm run layout:corpus -- <dir> <out>   # any directory of KiCad projects
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
export const DEFAULT_CORPUS_DIR = '/usr/share/kicad/demos';
const DEFAULT_OUT = path.join(REPO_ROOT, 'test', 'fixtures', 'layout-corpus-baseline.json');

export interface CorpusEntry {
  project: string;
  board: string;
  footprints: number;
  segments: number;
  vias: number;
  routableNets: number;
  routedNets: number;
  routedNetFraction: number;
  trackLengthMm: number;
  boardAreaMm2: number;
  score: number;
}

export async function findBoards(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const p = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile() && entry.name.endsWith('.kicad_pcb')) out.push(p);
    }
  }
  await walk(dir);
  return out.sort();
}

export async function scoreCorpus(dir: string): Promise<CorpusEntry[]> {
  const entries: CorpusEntry[] = [];
  for (const board of await findBoards(dir)) {
    const parsed = await readBoard(board);
    const m = computeLayoutMetrics({ ...parsed, filePath: path.relative(dir, board) }, {});
    entries.push({
      project: path.relative(dir, path.dirname(board)) || '.',
      board: path.relative(dir, board),
      footprints: m.soft.footprints,
      segments: m.soft.segments,
      vias: m.soft.vias,
      routableNets: m.soft.routableNets,
      routedNets: m.soft.routedNets,
      routedNetFraction: Math.round(m.soft.routedNetFraction * 1000) / 1000,
      trackLengthMm: m.soft.trackLengthMm,
      boardAreaMm2: m.soft.boardAreaMm2,
      score: m.score,
    });
  }
  return entries;
}

const percentile = (sorted: number[], p: number): number => {
  if (!sorted.length) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
};

async function main(): Promise<void> {
  const dir = process.argv[2] ?? DEFAULT_CORPUS_DIR;
  const out = process.argv[3] ?? DEFAULT_OUT;
  if (!existsSync(dir) || !(await stat(dir)).isDirectory()) {
    console.log(`corpus directory ${dir} is not present on this machine; nothing to record.`);
    console.log('The KiCad demos are an install artifact, not a Copperhead dependency.');
    return;
  }
  const entries = await scoreCorpus(dir);
  const scores = entries.map((e) => e.score).sort((a, b) => a - b);
  const baseline = {
    corpus: dir,
    boards: entries.length,
    // No generation timestamp on purpose: this file is committed, and a
    // timestamp would make every regeneration a diff even when nothing moved.
    distribution: {
      min: scores[0] ?? 0,
      p25: percentile(scores, 25),
      median: percentile(scores, 50),
      p75: percentile(scores, 75),
      max: scores[scores.length - 1] ?? 0,
      mean: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : 0,
    },
    entries,
  };
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
  console.log(`scored ${entries.length} board(s) from ${dir}`);
  for (const e of entries) {
    console.log(
      `  ${String(e.score).padStart(5)}  ${String(e.footprints).padStart(5)} fp  ` +
        `${String(e.segments).padStart(6)} seg  ${e.board}`,
    );
  }
  console.log(
    `distribution: min ${baseline.distribution.min}, p25 ${baseline.distribution.p25}, ` +
      `median ${baseline.distribution.median}, p75 ${baseline.distribution.p75}, max ${baseline.distribution.max}`,
  );
  console.log(`wrote ${path.relative(REPO_ROOT, out)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
