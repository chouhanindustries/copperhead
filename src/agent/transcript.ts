import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets } from '../util/redact.js';

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
