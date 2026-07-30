import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Turn-cost concentration (issue #145).
 *
 * A stage that emits 89% of its output in 5 of 40 turns and a stage that spreads
 * the same tokens evenly look identical in the run report today: one wall time,
 * one turn count, one token total. They are not the same run. The concentrated
 * one is the one that dies — every observed `provider-error` mid-response, the
 * 10-minute single-turn stall, and the budget exhaustion all landed on an
 * oversized turn — and it is the one whose turn budget is rationing the wrong
 * resource.
 *
 * Everything here is a pure function over the `perTurn` rows the loop already
 * records, so the same code scores a live run and a transcript recorded before
 * any of this existed.
 */

/** One row of the loop's per-turn accounting. `ms` is absent on older runs. */
export interface TurnSample {
  turn: number;
  in: number;
  out: number;
  ms?: number;
}

export interface TurnCostSummary {
  turns: number;
  /** Nearest-rank percentiles over the per-turn OUTPUT token counts. */
  p50TurnOut: number;
  p95TurnOut: number;
  maxTurnOut: number;
  /** Share of the run's output emitted by its five largest turns, 0..1. */
  top5TurnShare: number;
  /** Wall time of the slowest single turn, or null when no row carried one. */
  slowestTurnMs: number | null;
}

/** Nearest-rank percentile over an already-sorted ascending array. */
function nearestRank(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return 0;
  const rank = Math.ceil(p * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length, Math.max(1, rank)) - 1]!;
}

export function summarizeTurnCost(perTurn: readonly TurnSample[]): TurnCostSummary {
  const outs = perTurn.map((t) => (Number.isFinite(t.out) ? t.out : 0));
  if (!outs.length) {
    return { turns: 0, p50TurnOut: 0, p95TurnOut: 0, maxTurnOut: 0, top5TurnShare: 0, slowestTurnMs: null };
  }
  const sorted = [...outs].sort((a, b) => a - b);
  const total = outs.reduce((a, b) => a + b, 0);
  const top5 = [...sorted].reverse().slice(0, 5).reduce((a, b) => a + b, 0);
  const times = perTurn.map((t) => t.ms).filter((m): m is number => typeof m === 'number' && Number.isFinite(m));
  return {
    turns: outs.length,
    p50TurnOut: nearestRank(sorted, 0.5),
    p95TurnOut: nearestRank(sorted, 0.95),
    maxTurnOut: sorted[sorted.length - 1]!,
    // A run that emitted nothing (a full cache replay) is 0% concentrated, not
    // NaN: it spent no output, so no share of it sits anywhere.
    top5TurnShare: total > 0 ? top5 / total : 0,
    slowestTurnMs: times.length ? Math.max(...times) : null,
  };
}

/**
 * How much unverified file mutation a run accumulated. Counted at the tool layer
 * where the byte count is exact — `editBytesPerVerify` is the number the stage-4
 * prompt's "work ONE part at a time" rule was always trying to bound (the
 * 65-minute run reached ~12.5 kB per ERC).
 */
export interface EditPressure {
  edits: number;
  editBytes: number;
  largestEditBytes: number;
  verifications: number;
  /** Bytes written per ERC/DRC call; equals `editBytes` when nothing verified. */
  editBytesPerVerify: number;
}

export function editPressureOf(counts: {
  edits: number;
  editBytes: number;
  largestEditBytes: number;
  verifications: number;
}): EditPressure {
  return {
    ...counts,
    editBytesPerVerify: counts.verifications > 0 ? counts.editBytes / counts.verifications : counts.editBytes,
  };
}

export const EMPTY_EDIT_PRESSURE: EditPressure = {
  edits: 0,
  editBytes: 0,
  largestEditBytes: 0,
  verifications: 0,
  editBytesPerVerify: 0,
};

/** Sum two edit-pressure records (used to fold a stage's attempts together). */
export function addEditPressure(a: EditPressure, b: EditPressure): EditPressure {
  return editPressureOf({
    edits: a.edits + b.edits,
    editBytes: a.editBytes + b.editBytes,
    largestEditBytes: Math.max(a.largestEditBytes, b.largestEditBytes),
    verifications: a.verifications + b.verifications,
  });
}

interface TranscriptEvent {
  type: string;
  data?: Record<string, unknown>;
}

/**
 * Score a run directory recorded at any point in this project's history. The
 * concentration figures come from the `run-end` event's `perTurn` rows; edit
 * pressure is reconstructed from the `tool` events when the run predates the
 * in-loop counters. Returns null when the directory holds no readable
 * transcript, so a caller can distinguish "no data" from "zeroed data".
 */
export async function readRunTurnCost(
  runDir: string,
): Promise<{ cost: TurnCostSummary; pressure: EditPressure } | null> {
  const p = path.join(runDir, 'transcript.jsonl');
  if (!existsSync(p)) return null;
  let text: string;
  try {
    text = await readFile(p, 'utf8');
  } catch {
    return null;
  }
  let perTurn: TurnSample[] = [];
  let recorded: EditPressure | null = null;
  let edits = 0;
  let editBytes = 0;
  let largestEditBytes = 0;
  let verifications = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: TranscriptEvent;
    try {
      e = JSON.parse(line) as TranscriptEvent;
    } catch {
      continue;
    }
    if (e.type === 'run-end') {
      const rows = e.data?.perTurn;
      if (Array.isArray(rows)) perTurn = rows as TurnSample[];
      const pressure = e.data?.editPressure;
      if (pressure && typeof pressure === 'object') recorded = pressure as EditPressure;
    } else if (e.type === 'tool') {
      const name = String(e.data?.name ?? '');
      if (name === 'edit_file' || name === 'write_file') {
        const args = (e.data?.args ?? {}) as Record<string, unknown>;
        const payload = typeof args.new_string === 'string' ? args.new_string : typeof args.content === 'string' ? args.content : '';
        edits++;
        editBytes += Buffer.byteLength(payload, 'utf8');
        largestEditBytes = Math.max(largestEditBytes, Buffer.byteLength(payload, 'utf8'));
      } else if (name === 'run_erc' || name === 'run_drc') {
        verifications++;
      }
    }
  }
  return {
    cost: summarizeTurnCost(perTurn),
    // Prefer what the loop counted; fall back to the transcript reconstruction
    // for runs recorded before the counters existed.
    pressure: recorded ?? editPressureOf({ edits, editBytes, largestEditBytes, verifications }),
  };
}
