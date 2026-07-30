import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { CopperheadConfig } from '../config.js';
import { parseBomTable } from '../memory/bom-table.js';
import { listSymbols } from '../kicad/sexp.js';

/**
 * Computed stage progress (issue #145 §B5, design D8).
 *
 * The create pipeline infers stage completion from repo state, which makes it
 * resumable for free at STAGE granularity: a stage is either done or it starts
 * again from its prompt. That is too coarse for the two stages this issue is
 * about. A schematic stage killed at part 12 of 32 resumes with a prompt that
 * says "populate the schematic", and nothing in the run tells the model that
 * eleven parts are already there.
 *
 * So progress is computed the same way completion is: by comparing repo state
 * against the stage's unit list, and stated in one line appended to the stage
 * prompt. Checkpoint commits are what keep the finished units on disk for this
 * to find; together they are what "resume at the first incomplete unit" means
 * in a pipeline whose resume story is repo-state inference.
 *
 * Deliberately not a stored cursor: a remembered index goes stale the moment a
 * rollback or a hand edit moves the tree, and a stale cursor is worse than none.
 */
export interface StageProgress {
  /** Units already present in repo state. */
  done: number;
  /** Units the stage is expected to produce. */
  total: number;
  /** Names of the units that are not there yet, in document order. */
  missing: string[];
  /** The one line appended to the stage prompt. */
  line: string;
}

/** How many missing refdes to name before summarizing the rest. */
const NAMED_MISSING = 12;

function renderLine(done: number, total: number, missing: string[], noun: string, where: string): string {
  const named = missing.slice(0, NAMED_MISSING).join(', ');
  const rest = missing.length > NAMED_MISSING ? ` (and ${missing.length - NAMED_MISSING} more)` : '';
  return [
    `Progress: ${done} of ${total} ${noun} present in the ${where}; missing: ${named}${rest}.`,
    'Continue at the first missing unit rather than restarting; what is already present has been verified and committed.',
  ].join(' ');
}

/** Reference designators KiCad has on the board, from either property form. */
function boardRefdes(text: string): Set<string> {
  const refs = new Set<string>();
  // KiCad 7+ writes `(property "Reference" "R1"`; KiCad 6 and earlier wrote
  // `(fp_text reference R1` (quoted or bare). Read both so the progress line
  // does not silently report zero placements against an older board.
  for (const m of text.matchAll(/\(property\s+"Reference"\s+"([^"]+)"/g)) refs.add(m[1]!);
  for (const m of text.matchAll(/\(fp_text\s+reference\s+"?([^"\s)]+)"?/g)) refs.add(m[1]!);
  return refs;
}

/**
 * Progress for one create-pipeline stage, or null when the stage has no
 * countable unit list (every docs stage) or the inputs it would count against
 * are not there yet. Never throws: an unreadable BOM or an unparseable
 * schematic means no progress line, not a failed stage.
 */
export async function stageProgress(
  repoRoot: string,
  config: CopperheadConfig,
  stageName: string,
): Promise<StageProgress | null> {
  try {
    if (stageName === 'schematic') return await schematicProgress(repoRoot, config);
    if (stageName === 'layout-draft') return await layoutProgress(repoRoot, config);
    return null;
  } catch {
    return null;
  }
}

async function schematicProgress(repoRoot: string, config: CopperheadConfig): Promise<StageProgress | null> {
  const bomPath = path.join(repoRoot, config.docs, 'BOM.md');
  if (!existsSync(bomPath) || !config.schematic) return null;
  const wanted = parseBomTable(await readFile(bomPath, 'utf8')).map((r) => r.refdes);
  if (!wanted.length) return null;
  const schPath = path.join(repoRoot, config.schematic);
  const have = new Set(existsSync(schPath) ? (await listSymbols(schPath)).map((s) => s.ref) : []);
  const missing = wanted.filter((ref) => !have.has(ref));
  const done = wanted.length - missing.length;
  return {
    done,
    total: wanted.length,
    missing,
    line: missing.length
      ? renderLine(done, wanted.length, missing, 'BOM parts', 'schematic')
      : `Progress: all ${wanted.length} BOM parts are already present in the schematic; verify and wire what is there rather than re-adding symbols.`,
  };
}

async function layoutProgress(repoRoot: string, config: CopperheadConfig): Promise<StageProgress | null> {
  if (!config.schematic || !config.board) return null;
  const schPath = path.join(repoRoot, config.schematic);
  const boardPath = path.join(repoRoot, config.board);
  if (!existsSync(schPath)) return null;
  const wanted = (await listSymbols(schPath)).map((s) => s.ref).filter(Boolean);
  if (!wanted.length) return null;
  const have = existsSync(boardPath) ? boardRefdes(await readFile(boardPath, 'utf8')) : new Set<string>();
  const missing = wanted.filter((ref) => !have.has(ref));
  const done = wanted.length - missing.length;
  return {
    done,
    total: wanted.length,
    missing,
    line: missing.length
      ? renderLine(done, wanted.length, missing, 'schematic symbols', 'board as footprints')
      : `Progress: all ${wanted.length} schematic symbols already have footprints on the board; continue with placement and routing rather than re-importing.`,
  };
}
