import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv, loadEnvFile } from '../src/util/env.js';

const dirs: string[] = [];
function tmp(contents?: string): string {
  const d = mkdtempSync(path.join(tmpdir(), 'copperhead-env-'));
  dirs.push(d);
  if (contents !== undefined) writeFileSync(path.join(d, '.env'), contents, 'utf8');
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.COPPERHEAD_TEST_KEY;
  delete process.env.COPPERHEAD_TEST_OTHER;
});

describe('parseEnv', () => {
  it('reads plain assignments and ignores comments and blanks', () => {
    expect(parseEnv('# a comment\n\nFOO=bar\n  BAZ = qux  \n')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('accepts an export prefix', () => {
    expect(parseEnv('export FOO=bar')).toEqual({ FOO: 'bar' });
  });

  it('strips matched quotes', () => {
    expect(parseEnv('A="one"\nB=\'two\'')).toEqual({ A: 'one', B: 'two' });
  });

  it('keeps a # that is part of an unquoted secret', () => {
    // Only " #" (space-hash) starts a trailing comment, so key material
    // containing a bare # survives intact.
    expect(parseEnv('K=sk-ab#cd')).toEqual({ K: 'sk-ab#cd' });
  });

  it('strips a trailing comment from an unquoted value', () => {
    expect(parseEnv('K=value # trailing')).toEqual({ K: 'value' });
  });

  it('keeps a # inside a quoted value', () => {
    expect(parseEnv('K="a # b"')).toEqual({ K: 'a # b' });
  });

  it('ignores malformed lines', () => {
    expect(parseEnv('not an assignment\n=novalue\nOK=1')).toEqual({ OK: '1' });
  });
});

describe('loadEnvFile', () => {
  it('returns nothing when there is no .env', () => {
    expect(loadEnvFile(tmp())).toEqual([]);
  });

  it('sets unset variables and reports their names', () => {
    const applied = loadEnvFile(tmp('COPPERHEAD_TEST_KEY=from-file'));
    expect(applied).toEqual(['COPPERHEAD_TEST_KEY']);
    expect(process.env.COPPERHEAD_TEST_KEY).toBe('from-file');
  });

  it('never overrides a variable already in the environment', () => {
    process.env.COPPERHEAD_TEST_KEY = 'from-shell';
    const applied = loadEnvFile(tmp('COPPERHEAD_TEST_KEY=from-file\nCOPPERHEAD_TEST_OTHER=new'));
    expect(process.env.COPPERHEAD_TEST_KEY).toBe('from-shell');
    expect(applied).toEqual(['COPPERHEAD_TEST_OTHER']);
  });
});
