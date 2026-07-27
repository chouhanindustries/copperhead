import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runExplain, formatExplainReport, ExplainError } from '../src/commands/explain.js';
import { runInit } from '../src/memory/scaffold.js';
import { tempFixtureRepo } from './helpers.js';

async function fixtureRepo(): Promise<{ repo: string; cleanup: () => Promise<void> }> {
  const t = await tempFixtureRepo();
  await runInit({ repoRoot: t.repo, installHooks: false });
  return t;
}

describe('copperhead explain (minimal v1)', () => {
 it('explains a symbol by reference designator (copperhead explain U1)', async () => {
  const { repo, cleanup } = await fixtureRepo();
  try {
    const res = await runExplain(repo, 'U1');

    if (res.kind !== 'refdes') {
      throw new Error(`Expected refdes result, got ${res.kind}`);
    }

    expect(res.symbol).toBeDefined();
    expect(res.symbol.ref).toBe('U1');
    expect(res.pins).toBeDefined();

    const formatted = formatExplainReport(res);
    expect(formatted).toContain('Symbol U1:');
    expect(formatted).toContain('Value:');
    expect(formatted).toContain('Pins');
    expect(formatted).toContain(
      'BOM Rationale: extracted from schematic by copperhead init',
    );
  } finally {
    await cleanup();
  }
});

it('explains a net (copperhead explain GND)', async () => {
  const { repo, cleanup } = await fixtureRepo();
  try {
    const res = await runExplain(repo, 'GND');

    if (res.kind !== 'net') {
      throw new Error(`Expected net result, got ${res.kind}`);
    }

    expect(res.net).toBe('GND');

    const formatted = formatExplainReport(res);
    expect(formatted).toContain('Net GND:');
  } finally {
    await cleanup();
  }
});

  it('explains a pin (copperhead explain U1.1)', async () => {
  const { repo, cleanup } = await fixtureRepo();
  try {
    const res = await runExplain(repo, 'U1.1');

    if (res.kind !== 'pin') {
      throw new Error(`Expected pin result, got ${res.kind}`);
    }

    expect(res.pins).toHaveLength(1);
    expect(res.pins[0]!.ref).toBe('U1');

    const formatted = formatExplainReport(res);
    expect(formatted).toContain('Pin U1.');
    expect(formatted).toContain('Net:');
  } finally {
    await cleanup();
  }
});

  it('throws an ExplainError for a non-existent target', async () => {
    const { repo, cleanup } = await fixtureRepo();
    try {
      await expect(runExplain(repo, 'NONEXISTENT999')).rejects.toThrow(ExplainError);
      await expect(runExplain(repo, 'NONEXISTENT999')).rejects.toThrow(/not found in schematic/);
    } finally {
      await cleanup();
    }
  });

  it('throws an ExplainError when no schematic exists in repo', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ch-empty-repo-'));
    try {
      await expect(runExplain(dir, 'U1')).rejects.toThrow(ExplainError);
      await expect(runExplain(dir, 'U1')).rejects.toThrow(/no schematic configured/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
