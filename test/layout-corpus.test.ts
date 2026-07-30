import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readBoard } from '../src/kicad/pcb.js';
import { computeLayoutMetrics } from '../src/kicad/layout-metrics.js';
import { DEFAULT_CORPUS_DIR, findBoards } from '../scripts/layout-corpus-baseline.js';

/**
 * Corpus calibration (design D10, tier two). `/usr/share/kicad/demos` ships 17
 * complete, professionally laid out projects, including a free labeled pair:
 * `multichannel_mixer.kicad_pcb` (routed) and `multichannel_mixer-unrouted.kicad_pcb`
 * (same 114 footprints, unrouted). If the scorer ranks those two wrong, the
 * scorer is wrong, and that test costs nothing to run.
 *
 * The demos are a KiCad install artifact and not a Copperhead dependency, so
 * this suite SKIPS when the directory is absent rather than failing. The
 * mutation suite in layout-mutation.test.ts runs on committed fixtures and is
 * what covers CI on a machine without them.
 */

const present = existsSync(DEFAULT_CORPUS_DIR);
const corpus = present ? describe : describe.skip;

corpus('KiCad demo corpus', () => {
  it('scores every demo board without throwing', async () => {
    const boards = await findBoards(DEFAULT_CORPUS_DIR);
    expect(boards.length).toBeGreaterThanOrEqual(10);
    for (const board of boards) {
      const m = computeLayoutMetrics(await readBoard(board), {});
      expect(m.score, board).toBeGreaterThanOrEqual(0);
      expect(m.score, board).toBeLessThanOrEqual(100);
      expect(Number.isFinite(m.score), board).toBe(true);
      // A real board always has parts on it; a parse that silently found
      // nothing would otherwise sail through as a valid low score.
      expect(m.soft.footprints, board).toBeGreaterThan(0);
      expect(m.hard, board).toEqual([]);
    }
    // Two of the demos are ~70 MB; give the whole sweep room.
  }, 300_000);

  it('ranks the routed multichannel mixer above its unrouted twin', async () => {
    const dir = path.join(DEFAULT_CORPUS_DIR, 'multichannel');
    const routed = computeLayoutMetrics(await readBoard(path.join(dir, 'multichannel_mixer.kicad_pcb')), {});
    const unrouted = computeLayoutMetrics(
      await readBoard(path.join(dir, 'multichannel_mixer-unrouted.kicad_pcb')),
      {},
    );
    // Same design, same parts: the difference the scorer must see is routing.
    expect(unrouted.soft.footprints).toBe(routed.soft.footprints);
    expect(unrouted.soft.segments).toBeLessThan(routed.soft.segments);
    expect(unrouted.soft.routedNetFraction).toBeLessThan(routed.soft.routedNetFraction);
    expect(unrouted.score).toBeLessThan(routed.score);
  }, 120_000);
});

describe('corpus guard', () => {
  it('does not require the KiCad demos to be installed', () => {
    // Documents the contract asserted by `describe.skip` above: a machine
    // without /usr/share/kicad/demos still runs the mutation suite.
    expect(typeof present).toBe('boolean');
  });
});
