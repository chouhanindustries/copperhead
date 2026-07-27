/**
 * Bridges the KiCad pane's Python scenario suite into the vitest run
 * (AC-114B.8): plugins/kicad/tests/ covers the wx-free decision logic
 * (logic.py) and the serve child client (client.py) with stdlib unittest.
 * Skips only when no python3 exists (KiCad itself guarantees one for users).
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const hasPython = await execa('python3', ['--version']).then(
  () => true,
  () => false,
);

describe.skipIf(!hasPython)('KiCad pane python suite (plugins/kicad/tests)', () => {
  it('all scenarios pass', async () => {
    const res = await execa('python3', ['-m', 'unittest', 'discover', '-s', 'plugins/kicad/tests', '-v'], {
      cwd: REPO,
      reject: false,
      all: true,
    });
    if (res.exitCode !== 0) {
      // Surface the unittest output; otherwise a failure is just "exit 1".
      throw new Error(`python suite failed:\n${res.all}`);
    }
    expect(res.all).toMatch(/Ran \d+ tests/);
    expect(res.all).toContain('OK');
  }, 60000);
});
