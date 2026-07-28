/**
 * Scripted mock REPL session: the full interactive UI with canned agent
 * output; no LLM calls, no kicad-cli, no repo mutations. This is the
 * standard take for demo recordings (asciinema / GIF):
 *
 *   npm run demo:ui
 *
 * Suggested script: let the banner settle · type `/` and hover a few
 * commands · Esc · type "rename net KEY_DAH to KEY_DASH" · Enter · watch the
 * four sections play (~17s: the pinned observability row animates and the
 * working word morphs at each section) · PgUp/PgDn through the history ·
 * `/check` · Ctrl+C twice to exit.
 */

import { readFileSync } from 'node:fs';
import { runRepl } from '../src/commands/repl.js';
import { makeRenderer, plainRenderer, type ProgressRenderer } from '../src/agent/render.js';
import { ok, toolLine } from '../src/agent/theme.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

/**
 * One canned `do`-equivalent run, driven through the real session renderer so
 * the pinned observability row (spinner, morphing working word, tokens,
 * elapsed) animates exactly like a live run. Each pipeline section ends with
 * a summary log line.
 */
async function mockAgentRun(
  _request: string,
  log: (l: string) => void = console.log,
  renderer?: ProgressRenderer,
): Promise<{ outcome: 'success' }> {
  const r = renderer ?? plainRenderer(log);
  log('');

  // Section 1: propose (edit tools stay locked until the change validates).
  r.turnStart(1, 40, 900, 120);
  r.status('drafting an OpenSpec proposal');
  await sleep(1400);
  r.toolResult('read_file', 'docs/PINOUT.md (34 lines)');
  await sleep(900);
  r.toolResult('read_file', 'hardware/open-key.kicad_sch (1.2k lines)');
  await sleep(1500);
  r.toolResult('openspec_validate', 'change valid — edit tools unlocked');
  await sleep(500);
  log(ok('  ✓ propose: rename-key-dah validated, edit tools unlocked'));

  // Section 2: anchored edits.
  r.turnStart(2, 40, 4200, 800);
  r.status('applying anchored edits');
  await sleep(1700);
  r.toolResult('edit_file', 'hardware/open-key.kicad_sch — replaced 3 anchored regions');
  await sleep(1300);
  r.toolResult('edit_file', 'docs/PINOUT.md — updated net table');
  await sleep(500);
  log(ok('  ✓ edit: 2 files, 4 anchored regions'));

  // Section 3: verification gate.
  r.turnStart(3, 40, 9100, 1500);
  r.status('running ERC');
  await sleep(2300);
  r.toolResult('run_erc', 'clean — 0 violations');
  await sleep(1100);
  r.toolResult('check_drift', 'docs match schematic');
  await sleep(500);
  log(ok('  ✓ verify: ERC clean, no drift'));

  // Section 4: remember (docs-as-memory).
  r.turnStart(4, 40, 11800, 1900);
  r.status('writing the decision log');
  await sleep(1400);
  r.toolResult('log_decision', 'DECISIONS.md +1 · CHANGELOG.md +1');
  await sleep(600);
  log(ok('  ✓ remember: decision + changelog recorded'));

  r.finish('done · verified erc · committed 3f2c9a1 · 17s · 12.3k tokens');
  return { outcome: 'success' };
}

async function mockCheck(log: (l: string) => void = console.log): Promise<void> {
  await sleep(600);
  log(toolLine('run_erc', 'clean — 0 violations'));
  await sleep(500);
  log(toolLine('run_drc', 'clean — 0 violations'));
  await sleep(400);
  log(toolLine('check_drift', 'docs match schematic'));
  await sleep(300);
  log(ok('  ✓ check: all green'));
}

const res = await runRepl({
  repoRoot: process.cwd(),
  model: 'claude',
  modelSource: 'flag',
  version: pkg.version,
  kicadCliVersion: '9.0.4',
  renderer: makeRenderer({ json: false, plain: false }),
  runRequest: mockAgentRun,
  runCheckCmd: mockCheck,
});
process.exit(res.ok ? 0 : 1);
