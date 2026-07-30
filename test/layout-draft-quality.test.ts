import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { runInit } from '../src/memory/scaffold.js';
import { loadConfig } from '../src/config.js';
import { refreshDraftQuality, type CreateOptions } from '../src/commands/create.js';
import { saveConstraints } from '../src/memory/constraints.js';
import { tempFixtureRepo, REFERENCE_BOARD, REFERENCE_CONSTRAINTS } from './helpers.js';

const opts = (repo: string, log: (s: string) => void = () => {}): CreateOptions => ({
  repoRoot: repo,
  briefPath: path.join(repo, 'brief.md'),
  model: 'test',
  log,
});

describe('create pipeline: generated "## Draft quality" (D11)', () => {
  it('regenerates the computed block from the board and keeps the model prose', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const config = await loadConfig(repo);
      await copyFile(REFERENCE_BOARD, path.join(repo, config.board!));
      await saveConstraints(repo, REFERENCE_CONSTRAINTS);
      const layout = path.join(repo, config.docs, 'LAYOUT.md');
      await writeFile(
        layout,
        '# Layout\n\n## Draft quality\n\nFirst pass. The keepout is a guess and a human should redo it.\n',
        'utf8',
      );

      const lines: string[] = [];
      await refreshDraftQuality(opts(repo, (s) => lines.push(s)), 'layout-draft');

      const doc = await readFile(layout, 'utf8');
      expect(doc).toContain('**Layout score: 93.4 / 100**');
      expect(doc).toContain('`mech.load_trace_width_mm`');
      expect(doc).toContain('First pass. The keepout is a guess and a human should redo it.');
      expect(lines.join('\n')).toContain('score 93.4/100');

      // Degrade the board and regenerate: the block follows the board, the
      // prose does not move.
      const boardPath = path.join(repo, config.board!);
      await writeFile(
        boardPath,
        (await readFile(boardPath, 'utf8')).replace(/\(width 1\.5\)/g, '(width 0.25)'),
        'utf8',
      );
      const again: string[] = [];
      await refreshDraftQuality(opts(repo, (s) => again.push(s)), 'layout-draft');
      const doc2 = await readFile(layout, 'utf8');
      expect(doc2).not.toContain('**Layout score: 93.4 / 100**');
      expect(doc2).toContain('| 0.25 mm | fail |');
      expect(doc2).toContain('First pass. The keepout is a guess and a human should redo it.');
      expect(doc2.match(/^## Draft quality$/gm)).toHaveLength(1);
      expect(again.join('\n')).toContain('1 hard constraint(s) failing');
    } finally {
      await cleanup();
    }
  });

  it('does nothing for other stages, and nothing without a board or a LAYOUT.md', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const config = await loadConfig(repo);
      const layout = path.join(repo, config.docs, 'LAYOUT.md');
      const before = await readFile(layout, 'utf8');
      await refreshDraftQuality(opts(repo), 'schematic');
      expect(await readFile(layout, 'utf8')).toBe(before);
      // The scaffolded board is an empty outline: still regenerates, but says so.
      await refreshDraftQuality(opts(repo), 'layout-draft');
      const after = await readFile(layout, 'utf8');
      expect(after).toContain('## Draft quality');
      expect(after).toContain('| Footprints | 0 |');
    } finally {
      await cleanup();
    }
  });
});
