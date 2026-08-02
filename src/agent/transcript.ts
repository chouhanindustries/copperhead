import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets } from '../util/redact.js';
import { renderEnvironmentSection, type RunMeta } from './runmeta.js';
import { fmtDuration, fmtTokens } from './render.js';
import type { EditPressure, TurnCostSummary, TurnSample } from './turn-metrics.js';

/** How a run terminated — the single most-queried triage fact (AC-8.5). */
export type ExitPath =
  | 'done'
  | 'refused'
  | 'turn-budget-exhausted'
  // Kept distinct from turn exhaustion on purpose: the create pipeline escalates
  // the turn budget on `turn-budget-exhausted` (issue #135), and doing that for a
  // run that overspent tokens or wall clock would be the wrong remedy.
  | 'token-budget-exhausted'
  | 'wall-budget-exhausted'
  | 'repair-cycles-exhausted'
  | 'commit-failed'
  | 'provider-error'
  | 'session-limit'
  | 'stalled';

/** Post-run addenda recorded at every terminal branch (AC-8.5). */
export interface RunStats {
  exitPath: ExitPath;
  turnsUsed: number;
  maxTurns: number;
  repairCyclesUsed: number;
  maxRepairCycles: number;
  tokensIn: number;
  tokensOut: number;
  /** `ms` is this turn's wall time; absent on runs recorded before issue #145. */
  perTurn: TurnSample[];
  durationMs: number;
  /** Turn-cost concentration, derived from `perTurn` (issue #145 §A). */
  turnCost?: TurnCostSummary;
  /** How much unverified mutation the run accumulated per verification. */
  editPressure?: EditPressure;
}

export interface RunSummaryData {
  request: string;
  changeId: string | null;
  plan: string | null;
  filesTouched: string[];
  ercResult: string | null;
  drcResult: string | null;
  decisions: string[];
  tokensIn: number;
  tokensOut: number;
  outcome: 'success' | 'failure' | 'aborted';
  openObligations: string | null;
  detail?: string;
  env?: RunMeta;
  stats?: RunStats;
}

function renderRunStats(s: RunStats): string[] {
  return [
    `## Run stats`,
    ``,
    `- **Exit path:** ${s.exitPath}`,
    `- **Turns:** ${s.turnsUsed} / ${s.maxTurns}`,
    `- **Repair cycles:** ${s.repairCyclesUsed} / ${s.maxRepairCycles}`,
    `- **Tokens:** ${fmtTokens(s.tokensIn)} in / ${fmtTokens(s.tokensOut)} out`,
    `- **Duration:** ${fmtDuration(s.durationMs)}`,
    ...(s.perTurn.length
      ? [`- **Per turn:** ${s.perTurn.map((t) => `${t.turn}: ${t.in}/${t.out}`).join(' · ')}`]
      : []),
    // Concentration is the leading indicator issue #145 asks for: a run whose
    // top-5 turns carry ~90% of the output is one interrupted response away from
    // losing everything, and the totals above cannot show that.
    ...(s.turnCost
      ? [
          `- **Turn cost:** p50 ${s.turnCost.p50TurnOut} · p95 ${s.turnCost.p95TurnOut} · max ${s.turnCost.maxTurnOut} out tokens · ` +
            `top-5 share ${(s.turnCost.top5TurnShare * 100).toFixed(0)}%` +
            (s.turnCost.slowestTurnMs !== null ? ` · slowest turn ${fmtDuration(s.turnCost.slowestTurnMs)}` : ''),
        ]
      : []),
    ...(s.editPressure
      ? [
          `- **Edit pressure:** ${s.editPressure.edits} edit(s), ${s.editPressure.verifications} verification(s), ` +
            `${Math.round(s.editPressure.editBytesPerVerify)} B per verify · largest edit ${s.editPressure.largestEditBytes} B`,
        ]
      : []),
  ];
}

/**
 * Audit trail for a run: JSONL transcript plus a human-readable summary.md,
 * both redacted at write time (AC-4.1, design D12).
 */
export class Transcript {
  readonly dir: string;
  readonly jsonlPath: string;

  constructor(repoRoot: string, stamp = new Date()) {
    const ts = stamp.toISOString().replace(/[:.]/g, '-');
    this.dir = path.join(repoRoot, '.copperhead', 'runs', ts);
    this.jsonlPath = path.join(this.dir, 'transcript.jsonl');
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.jsonlPath, '', 'utf8');
  }

  async event(type: string, data: unknown): Promise<void> {
    const line = redactSecrets(JSON.stringify({ ts: new Date().toISOString(), type, data }));
    // The audit trail must survive anything that happens to the working tree
    // mid-run (a rollback path once deleted this directory); losing an event
    // is acceptable, crashing the run to report one is not.
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.jsonlPath, line + '\n', 'utf8');
  }

  async writeSummary(s: RunSummaryData): Promise<string> {
    const lines = [
      `# Run summary`,
      ``,
      `- **Request:** ${s.request}`,
      `- **Outcome:** ${s.outcome}`,
      `- **OpenSpec change:** ${s.changeId ?? 'n/a'}`,
      `- **Tokens:** ${s.tokensIn} in / ${s.tokensOut} out`,
      ``,
      ...(s.env ? [...renderEnvironmentSection(s.env), ``] : []),
      ...(s.stats ? [...renderRunStats(s.stats), ``] : []),
      `## Plan`,
      ``,
      s.plan ?? '(no plan recorded)',
      ``,
      `## Files touched`,
      ``,
      ...(s.filesTouched.length ? s.filesTouched.map((f) => `- ${f}`) : ['(none)']),
      ``,
      `## Verification`,
      ``,
      `- ERC: ${s.ercResult ?? 'not run'}`,
      `- DRC: ${s.drcResult ?? 'not run'}`,
      ``,
      `## Decisions`,
      ``,
      ...(s.decisions.length ? s.decisions.map((d) => `- ${d}`) : ['(none)']),
    ];
    if (s.openObligations) {
      lines.push('', '## Open sync obligations (unmet at run end)', '', s.openObligations);
    }
    if (s.detail) lines.push('', '## Detail', '', s.detail);
    const out = path.join(this.dir, 'summary.md');
    await mkdir(this.dir, { recursive: true });
    await writeFile(out, redactSecrets(lines.join('\n') + '\n'), 'utf8');
    return out;
  }
}
