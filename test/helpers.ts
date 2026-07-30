import { mkdtemp, cp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import type { ConstraintRegistry } from '../src/memory/constraints.js';

export const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'open-key');
export const REPORTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'reports');
/** Hand-built, DRC-plausible 60x40 mm two-layer board the layout scorer is calibrated on. */
export const REFERENCE_BOARD = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'layout',
  'reference-board.kicad_pcb',
);

/**
 * The registry the reference board is measured against: exactly one key per
 * hard-table matcher, so the mutation suite can watch a single row flip.
 */
export const REFERENCE_CONSTRAINTS: ConstraintRegistry = {
  'mech.load_trace_width_mm': { min: 1.5, source: 'docs/SPEC.md', affects: ['layout'] },
  'mech.board_outline_mm': { value: '60x40', source: 'docs/SPEC.md', affects: ['layout'] },
  'sense.optical_feedback_keepout': { min: 20, value: 'J1 to R1', source: 'docs/SPEC.md', affects: ['layout'] },
  'mech.mounting_hole_clearance_mm': { min: 1.5, source: 'docs/SPEC.md', affects: ['layout'] },
  'power.decoupling_distance_mm': { max: 5, source: 'docs/SPEC.md', affects: ['layout'] },
  'thermal.copper_area_mm2': { min: 500, value: 'GND', source: 'docs/SPEC.md', affects: ['layout'] },
};

/** Copy the open-key fixture into a fresh temp dir and git-init it. */
export async function tempFixtureRepo(): Promise<{ repo: string; cleanup: () => Promise<void> }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-test-'));
  await cp(FIXTURE, repo, { recursive: true });
  // the target-repo convention (AC-4.3): .env and the run audit trail ignored
  await writeFile(path.join(repo, '.gitignore'), '.env\n.copperhead/runs/\n', 'utf8');
  await execa('git', ['init', '-q'], { cwd: repo });
  await execa('git', ['config', 'user.email', 'test@copperhead.local'], { cwd: repo });
  await execa('git', ['config', 'user.name', 'copperhead-test'], { cwd: repo });
  await execa('git', ['add', '-A'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', 'fixture'], { cwd: repo });
  return { repo, cleanup: () => rm(repo, { recursive: true, force: true }) };
}
