import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import {
  budgetContinuePrompt,
  budgetExtraTurns,
  budgetPromptText,
  parseMaxTurns,
  repoOf,
  type PromptIo,
} from '../src/util/cli-args.js';
import { setColorEnabled, styleOutcome, styleHeaderLines } from '../src/agent/theme.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('--max-turns parsing', () => {
  it('accepts positive integers, including exponent notation', () => {
    expect(parseMaxTurns('1')).toBe(1);
    expect(parseMaxTurns('40')).toBe(40);
    expect(parseMaxTurns('1e3')).toBe(1000);
  });

  it('refuses anything that is not a positive integer', () => {
    for (const bad of ['0', '-1', '2.5', 'NaN', '5oops', 'Infinity', ' ']) {
      expect(() => parseMaxTurns(bad), bad).toThrow(/positive integer/);
    }
  });

  it('names the offending value so the refusal is actionable', () => {
    expect(() => parseMaxTurns('5oops')).toThrow('"5oops"');
  });
});

describe('--repo resolution', () => {
  it('resolves a relative path against the working directory', () => {
    expect(repoOf({ repo: '.' })).toBe(path.resolve('.'));
  });

  it('passes an absolute path through unchanged', () => {
    expect(repoOf({ repo: '/tmp/some-repo' })).toBe('/tmp/some-repo');
  });

  it('defaults to the working directory', () => {
    expect(repoOf({})).toBe(path.resolve(process.cwd()));
  });
});

describe('budget-exhausted prompt (design D1)', () => {
  const stats = {
    maxTurns: 40,
    turnsUsed: 40,
    tokensIn: 12_345,
    tokensOut: 6_789,
    filesTouched: ['a.kicad_sch', 'b.md'],
    openObligations: 1,
  };

  it('offers half the ORIGINAL budget, so repeat extensions do not escalate', () => {
    expect(budgetExtraTurns({ maxTurns: 40 })).toBe(20);
    expect(budgetExtraTurns({ maxTurns: 41 })).toBe(21); // ceil, never zero
    expect(budgetExtraTurns({ maxTurns: 1 })).toBe(1);
  });

  it('spells out the cost of the run so far', () => {
    const q = budgetPromptText(stats);
    expect(q).toContain('40 turns');
    expect(q).toContain('12.3k in / 6.8k out');
    expect(q).toContain('2 file(s) touched');
    expect(q).toContain('1 open obligation(s)');
    expect(q).toContain('Continue with 20 more turns?');
  });

  // Issue #135: gating on stdout as well as stdin removed the escape hatch from
  // every `| tee run.log` run, which is how a long create pipeline is watched.
  describe('is offered whenever stdin is a terminal', () => {
    function io(stdinTty: boolean, stdoutTty: boolean): PromptIo & { asked: string[] } {
      const stdin = Object.assign(new PassThrough(), { isTTY: stdinTty });
      const stdout = Object.assign(new PassThrough(), { isTTY: stdoutTty });
      const stderr = new PassThrough();
      const asked: string[] = [];
      stdout.on('data', (c: Buffer) => asked.push(`stdout:${c.toString()}`));
      stderr.on('data', (c: Buffer) => asked.push(`stderr:${c.toString()}`));
      return { stdin, stdout, stderr, asked };
    }

    it('is returned when stdin is a TTY and stdout is not, and asks on stderr', async () => {
      const { stdin, stdout, stderr, asked } = io(true, false);
      const prompt = budgetContinuePrompt({ stdin, stdout, stderr });
      expect(prompt).toBeTypeOf('function');

      const answered = prompt!(stats);
      stdin.write('y\n');
      expect(await answered).toBe(20); // budgetExtraTurns(40)

      const text = asked.join('');
      expect(text).toContain('stderr:');
      expect(text).toContain('Turn budget exhausted');
      expect(text).not.toContain('stdout:');
    });

    it('asks on stdout when stdout is a TTY too', async () => {
      const { stdin, stdout, stderr, asked } = io(true, true);
      const answered = budgetContinuePrompt({ stdin, stdout, stderr })!(stats);
      stdin.write('n\n');
      expect(await answered).toBe(0); // declined: fail and restore

      expect(asked.join('')).toContain('stdout:');
    });

    it('is absent when stdin is not a TTY, so CI keeps fail-and-restore', () => {
      const { stdin, stdout, stderr } = io(false, true);
      expect(budgetContinuePrompt({ stdin, stdout, stderr })).toBeUndefined();
    });
  });
});

describe('theme styling (color on)', () => {
  // These branches early-return when color is off, which is how every other
  // suite runs them, so they need their own explicit color-on coverage.
  beforeEach(() => setColorEnabled(true));

  it('colors a successful outcome differently from a refusal', () => {
    const done = styleOutcome('done · 3 turns');
    const refused = styleOutcome('refused · over budget');
    expect(done).toContain('done');
    expect(refused).toContain('refused');
    expect(done).not.toBe(refused);
    // The head is painted and the tail dimmed, so both carry SGR.
    expect(done).toMatch(/\x1b\[/);
    expect(refused).toMatch(/\x1b\[/);
  });

  it('treats every failure token as a failure', () => {
    for (const head of ['refused', 'failed', 'error', 'exhausted', 'stalled']) {
      expect(styleOutcome(`${head} · x`), head).toBe(styleOutcome('refused · x').replace('refused', head));
    }
  });

  it('paints the brand in the header and dims the rest', () => {
    const [first, second] = styleHeaderLines(['copperhead v0.7.0 · gpt-5 · repo', 'second line']);
    expect(first).toContain('copperhead v0.7.0');
    expect(first).toMatch(/\x1b\[/);
    expect(second).toContain('second line');
  });

  it('dims a first line that does not match the brand pattern', () => {
    const [only] = styleHeaderLines(['not the banner']);
    expect(only).toContain('not the banner');
    expect(only).toMatch(/\x1b\[/);
  });

  it('is a pass-through when color is off', () => {
    setColorEnabled(false);
    expect(styleOutcome('done · 3 turns')).toBe('done · 3 turns');
    expect(styleHeaderLines(['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('demo --tour honours --json', () => {
  // The only end-to-end check of the CLI wiring: --tour short-circuits before
  // the try block, so it used to print prose even under --json. Runs the real
  // entry point through tsx; --tour touches no network and no kicad-cli.
  it('emits structured JSON, not prose, under --json', async () => {
    const res = await execa('npx', ['tsx', 'src/cli.ts', '--json', 'demo', '--tour'], {
      cwd: ROOT,
      reject: false,
      env: { NO_COLOR: '1' },
    });
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout) as { tour: string[] };
    expect(Array.isArray(parsed.tour)).toBe(true);
    expect(parsed.tour.join('\n')).toContain('copperhead');
    // Machine-readable means no leftover SGR in the payload.
    expect(res.stdout).not.toMatch(/\x1b\[/);
  }, 60_000);

  it('still prints prose without --json', async () => {
    const res = await execa('npx', ['tsx', 'src/cli.ts', 'demo', '--tour'], {
      cwd: ROOT,
      reject: false,
      env: { NO_COLOR: '1' },
    });
    expect(res.exitCode).toBe(0);
    expect(() => JSON.parse(res.stdout)).toThrow();
    expect(res.stdout).toContain('copperhead');
  }, 60_000);
});

describe('create --max-turns (issue #135)', () => {
  it('is advertised in the help and refuses a bad value before doing any work', async () => {
    const help = await execa('npx', ['tsx', 'src/cli.ts', 'create', '--help'], {
      cwd: ROOT,
      reject: false,
      env: { NO_COLOR: '1' },
    });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('--max-turns');

    const bad = await execa(
      'npx',
      ['tsx', 'src/cli.ts', 'create', '--brief', 'nope.md', '--max-turns', '5oops'],
      { cwd: ROOT, reject: false, env: { NO_COLOR: '1' } },
    );
    expect(bad.exitCode).not.toBe(0);
    expect(`${bad.stdout}${bad.stderr}`).toContain('--max-turns must be a positive integer');
  }, 60_000);
});
