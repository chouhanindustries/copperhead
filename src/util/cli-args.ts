/**
 * Pure argument helpers for the CLI surface. They live here rather than in
 * cli.ts because that module wires up commander and parses argv at import
 * time, which makes it untestable in-process: importing it runs the program.
 * Anything with a branch worth pinning belongs on this side of the line.
 */

import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { BudgetExhaustedStats } from '../agent/loop.js';

/** Resolve `--repo` against the working directory; absolute paths pass through. */
export function repoOf(opts: { repo?: string }): string {
  return path.resolve(opts.repo ?? process.cwd());
}

/** `--max-turns` accepts only a positive integer; "5oops" and "NaN" refuse to start. */
export function parseMaxTurns(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--max-turns must be a positive integer, got "${raw}"`);
  }
  return n;
}

/**
 * Turns offered when the budget runs out: ceil of the ORIGINAL budget (design
 * D1), so repeat extensions offer the same increment instead of escalating
 * with the already-extended turn count.
 */
export function budgetExtraTurns(stats: Pick<BudgetExhaustedStats, 'maxTurns'>): number {
  return Math.ceil(stats.maxTurns / 2);
}

/** The attended "continue?" question, with the cost of the run so far spelled out. */
export function budgetPromptText(stats: BudgetExhaustedStats): string {
  const k = (n: number): string => `${(n / 1000).toFixed(1)}k`;
  return (
    `Turn budget exhausted (${stats.turnsUsed} turns, ${k(stats.tokensIn)} in / ${k(stats.tokensOut)} out, ` +
    `${stats.filesTouched.length} file(s) touched, ${stats.openObligations} open obligation(s)). ` +
    `Continue with ${budgetExtraTurns(stats)} more turns?`
  );
}

/**
 * Ask a yes/no question on a terminal. The output stream is a parameter because
 * the question must still be visible when stdout is redirected or piped: the
 * caller then hands us stderr, which `> file` and `| tee` leave alone.
 */
export async function confirmTty(
  question: string,
  output: NodeJS.WritableStream = process.stdout,
  input: NodeJS.ReadableStream = process.stdin,
): Promise<boolean> {
  const rl = createInterface({ input, output });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/** The streams `budgetContinuePrompt` reads the answer from and asks on. */
export interface PromptIo {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean | undefined };
  stdout: NodeJS.WritableStream & { isTTY?: boolean | undefined };
  stderr: NodeJS.WritableStream;
}

/**
 * Attended runs get a decision point instead of a rollback when the turn budget
 * runs out (issue #15). Only stdin needs to be a terminal: that is where the
 * answer comes from. Gating on stdout as well (as this did originally) silently
 * removed the escape hatch from every `| tee run.log` run, which is exactly how
 * a long create pipeline is usually watched (issue #135). When stdout is not a
 * TTY the question is asked on stderr instead. No stdin TTY at all (CI) still
 * means no prompt: fail-and-restore, unchanged.
 */
export function budgetContinuePrompt(
  io: PromptIo = process,
): ((stats: BudgetExhaustedStats) => Promise<number>) | undefined {
  if (!io.stdin.isTTY) return undefined;
  const output = io.stdout.isTTY ? io.stdout : io.stderr;
  return async (stats) =>
    (await confirmTty(budgetPromptText(stats), output, io.stdin)) ? budgetExtraTurns(stats) : 0;
}
