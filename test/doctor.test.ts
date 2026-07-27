import { describe, it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runDoctor, checkCredential, formatDoctor, type DoctorDeps } from '../src/commands/doctor.js';
import { tempFixtureRepo } from './helpers.js';

// Deps that make every host-dependent probe deterministic.
function deps(over: Partial<DoctorDeps> = {}): Partial<DoctorDeps> {
  return {
    nodeVersion: 'v20.0.0',
    kicadVersion: async () => 'kicad-cli 9.0.0',
    gitVersion: async () => 'git version 2.43.0',
    env: {},
    ...over,
  };
}

describe('copperhead doctor', () => {
  it('all green when node/kicad/git are present and the provider credential is set', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const r = await runDoctor({ repoRoot: repo, model: 'gpt-5', deps: deps({ env: { OPENAI_API_KEY: 'sk-x' } }) });
      expect(r.ok).toBe(true);
      const provider = r.checks.find((c) => c.name === 'provider')!;
      expect(provider.status).toBe('ok');
      expect(provider.detail).toContain('OPENAI_API_KEY set');
    } finally {
      await cleanup();
    }
  });

  it('fails (ok=false) and gives a hint when the resolved provider key is missing', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const r = await runDoctor({ repoRoot: repo, model: 'gpt-5', deps: deps({ env: {} }) });
      expect(r.ok).toBe(false);
      const provider = r.checks.find((c) => c.name === 'provider')!;
      expect(provider.status).toBe('fail');
      expect(provider.hint).toContain('OPENAI_API_KEY');
    } finally {
      await cleanup();
    }
  });

  it('reports a missing kicad-cli as a failure with an install hint (does not throw)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const r = await runDoctor({
        repoRoot: repo,
        model: 'claude-code',
        deps: deps({
          kicadVersion: async () => {
            throw new Error('ENOENT');
          },
        }),
      });
      expect(r.ok).toBe(false);
      const kicad = r.checks.find((c) => c.name === 'kicad-cli')!;
      expect(kicad.status).toBe('fail');
      expect(kicad.hint).toMatch(/install KiCad/i);
    } finally {
      await cleanup();
    }
  });

  it('a corrupted .copperhead/config.json fails the project check, not the whole command', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(path.join(repo, '.copperhead', 'config.json'), '{ this is not valid json,,,', 'utf8');
      const r = await runDoctor({ repoRoot: repo, model: 'gpt-5', deps: deps({ env: { OPENAI_API_KEY: 'sk-x' } }) });
      expect(r.ok).toBe(false);
      const project = r.checks.find((c) => c.name === 'project')!;
      expect(project.status).toBe('fail');
      expect(project.detail).toContain('malformed');
      // Provider resolution still works from --model/env, unaffected by the broken config.
      const provider = r.checks.find((c) => c.name === 'provider')!;
      expect(provider.status).toBe('ok');
    } finally {
      await cleanup();
    }
  });

  it('an unreadable .copperhead/config.json (e.g. EISDIR) gets read-failure advice, not "malformed"', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      // A directory at the config path reproduces an fs read error (EISDIR)
      // distinct from JSON.parse's SyntaxError.
      await mkdir(path.join(repo, '.copperhead', 'config.json'), { recursive: true });
      const r = await runDoctor({ repoRoot: repo, model: 'gpt-5', deps: deps({ env: { OPENAI_API_KEY: 'sk-x' } }) });
      const project = r.checks.find((c) => c.name === 'project')!;
      expect(project.status).toBe('fail');
      expect(project.detail).toContain('could not be read');
      expect(project.detail).not.toContain('malformed');
      expect(project.hint).toMatch(/permission|directory/i);
    } finally {
      await cleanup();
    }
  });

  it('a saved-login provider needs no key: info, not a failure', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const r = await runDoctor({ repoRoot: repo, model: 'claude-code', deps: deps({ env: {} }) });
      const provider = r.checks.find((c) => c.name === 'provider')!;
      expect(provider.status).toBe('info');
      expect(r.ok).toBe(true); // info never blocks
    } finally {
      await cleanup();
    }
  });

  it('an old node major fails the node check', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const r = await runDoctor({ repoRoot: repo, model: 'claude-code', deps: deps({ nodeVersion: 'v18.19.0' }) });
      expect(r.checks.find((c) => c.name === 'node')!.status).toBe('fail');
      expect(r.ok).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('checkCredential maps each model prefix to the right credential', () => {
    expect(checkCredential('claude-3-7', { ANTHROPIC_API_KEY: 'x' }).status).toBe('ok');
    expect(checkCredential('claude-3-7', {}).status).toBe('fail');
    expect(checkCredential('o3', { OPENAI_API_KEY: 'x' }).status).toBe('ok');
    expect(checkCredential('o3', {}).status).toBe('fail');
    expect(checkCredential('codex:gpt-5', {}).status).toBe('info');
    expect(checkCredential('claude-code:opus', {}).status).toBe('info');
    expect(checkCredential('cursor', {}).status).toBe('info');
    expect(checkCredential('cursor:gpt-5', {}).status).toBe('info');
  });

  it('an empty saved-login override fails like makeProvider would, not info', () => {
    for (const model of ['codex:', 'claude-code:', 'cursor:']) {
      const c = checkCredential(model, {});
      expect(c.status).toBe('fail');
      expect(c.hint).toContain(`${model}<model-id>`);
    }
    expect(checkCredential('codex', {}).status).toBe('info');
    expect(checkCredential('claude-code', {}).status).toBe('info');
  });

  it('a secret-shaped model value is redacted from the report', () => {
    const c = checkCredential('sk-proj-abc123XYZ', { OPENAI_API_KEY: 'x' });
    expect(JSON.stringify(c)).not.toContain('sk-proj-abc123XYZ');
    expect(c.detail).toContain('[REDACTED]');
    expect(c.status).toBe('ok'); // classification still runs on the raw value
  });

  it('formatDoctor renders a ready/not-ready footer', () => {
    const ready = formatDoctor({ ok: true, checks: [] });
    expect(ready[ready.length - 1]).toBe('ready');
    const notReady = formatDoctor({ ok: false, checks: [] });
    expect(notReady[notReady.length - 1]).toMatch(/not ready/);
  });

  it('formatDoctor wraps long detail and hint text within the given width', () => {
    const lines = formatDoctor(
      {
        ok: false,
        checks: [
          {
            name: 'provider',
            status: 'fail',
            detail: 'no model configured',
            hint: 'pass --model codex, set COPPERHEAD_MODEL, set model in .copperhead/config.json, or provide OPENAI_API_KEY/ANTHROPIC_API_KEY',
          },
        ],
      },
      60,
    );
    expect(lines.length).toBeGreaterThan(3); // head + wrapped hint + footer
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);
    // Continuation lines align under the start of the hint text.
    const hintLine = lines.find((l) => l.includes('hint: '))!;
    const contCol = hintLine.indexOf('hint: ') + 'hint: '.length;
    const continuation = lines[lines.indexOf(hintLine) + 1];
    expect(continuation.startsWith(' '.repeat(contCol))).toBe(true);
    expect(continuation.charAt(contCol)).not.toBe(' ');
  });

  it('formatDoctor color mode only adds ANSI codes: stripping them yields the plain output', () => {
    const report = {
      ok: false,
      checks: [
        { name: 'node', status: 'ok' as const, detail: 'v20.0.0 (>= 20)' },
        { name: 'provider', status: 'fail' as const, detail: 'no model configured', hint: 'set COPPERHEAD_MODEL' },
      ],
    };
    const plain = formatDoctor(report, 80);
    expect(plain.join('\n')).not.toContain('\u001b[');
    const colored = formatDoctor(report, 80, true);
    expect(colored.join('\n')).toContain('\u001b[31m'); // red FAIL tag
    // eslint-disable-next-line no-control-regex
    const stripped = colored.map((l) => l.replace(/\u001b\[[0-9]+m/g, ''));
    expect(stripped).toEqual(plain);
  });

  it('reports a missing git as a failure with an install hint (does not throw)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const r = await runDoctor({
        repoRoot: repo,
        model: 'gpt-5',
        deps: deps({
          env: { OPENAI_API_KEY: 'sk-x' },
          gitVersion: async () => {
            throw new Error('ENOENT');
          },
        }),
      });
      expect(r.ok).toBe(false);
      const git = r.checks.find((c) => c.name === 'git')!;
      expect(git.status).toBe('fail');
      expect(git.hint).toMatch(/install git/i);
    } finally {
      await cleanup();
    }
  });

  it('with a config present, the project check reports the wired schematic and board', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        JSON.stringify({ schematic: 'blinky.kicad_sch', board: null }),
      );
      const r = await runDoctor({ repoRoot: repo, model: 'gpt-5', deps: deps({ env: { OPENAI_API_KEY: 'sk-x' } }) });
      const project = r.checks.find((c) => c.name === 'project')!;
      expect(project.status).toBe('info');
      expect(project.detail).toContain('blinky.kicad_sch');
      expect(project.detail).toContain('not wired');
    } finally {
      await cleanup();
    }
  });

  it('the no-model hint does not repeat the "no model configured" detail', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const r = await runDoctor({ repoRoot: repo, deps: deps({ env: {} }) });
      const provider = r.checks.find((c) => c.name === 'provider')!;
      expect(provider.status).toBe('fail');
      expect(provider.detail).toBe('no model configured');
      expect(provider.hint).not.toContain('no model configured');
      expect(provider.hint).toContain('COPPERHEAD_MODEL');
    } finally {
      await cleanup();
    }
  });
});
