import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { bootstrapKicadProject, projectSlug } from '../src/kicad/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { listSymbols } from '../src/kicad/sexp.js';
import { kicadLoadError } from '../src/kicad/cli.js';

const BRIEF = '# Brief: USB-C power breakout\n\nA small board.\n';

async function emptyRepo(): Promise<{ repo: string; cleanup: () => Promise<void> }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-bootstrap-'));
  await mkdir(path.join(repo, '.copperhead'), { recursive: true });
  return { repo, cleanup: () => rm(repo, { recursive: true, force: true }) };
}

describe('KiCad project bootstrap (create schematic-stage gap #19)', () => {
  it('derives a filename slug from the brief H1, dropping a "Brief:" label', () => {
    expect(projectSlug(BRIEF)).toBe('usb-c-power-breakout');
    expect(projectSlug('# My Cool Board\n')).toBe('my-cool-board');
    expect(projectSlug('no heading here')).toBe('board');
  });

  it('scaffolds an empty, loadable project and wires config', async () => {
    const { repo, cleanup } = await emptyRepo();
    try {
      const created = await bootstrapKicadProject(repo, BRIEF);
      expect(created).toBe('usb-c-power-breakout.kicad_sch');
      expect(existsSync(path.join(repo, 'usb-c-power-breakout.kicad_sch'))).toBe(true);
      expect(existsSync(path.join(repo, 'usb-c-power-breakout.kicad_pcb'))).toBe(true);
      expect(existsSync(path.join(repo, 'usb-c-power-breakout.kicad_pro'))).toBe(true);

      const config = await loadConfig(repo);
      expect(config.schematic).toBe('usb-c-power-breakout.kicad_sch');
      expect(config.board).toBe('usb-c-power-breakout.kicad_pcb');

      // Empty but valid: parses to zero symbols and loads in KiCad.
      expect(await listSymbols(path.join(repo, config.schematic!))).toHaveLength(0);
      expect(await kicadLoadError(path.join(repo, config.schematic!))).toBeNull();
      expect(await kicadLoadError(path.join(repo, config.board!))).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('is idempotent: a second call is a no-op once config points at a schematic', async () => {
    const { repo, cleanup } = await emptyRepo();
    try {
      await bootstrapKicadProject(repo, BRIEF);
      const before = await readFile(path.join(repo, 'usb-c-power-breakout.kicad_sch'), 'utf8');
      const second = await bootstrapKicadProject(repo, BRIEF);
      expect(second).toBeNull();
      const after = await readFile(path.join(repo, 'usb-c-power-breakout.kicad_sch'), 'utf8');
      expect(after).toBe(before); // untouched
    } finally {
      await cleanup();
    }
  });
});
