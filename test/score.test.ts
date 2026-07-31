import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { scoreSchematic } from '../src/kicad/score.js';

/** Hand-computed metric values against constructed geometry (task 8.4). */

function sch(body: string): string {
  return `(kicad_sch (version 20231120) (uuid "5c0e0000-0000-4000-8000-000000000001") (paper "A4")
  (title_block (title "t") (date "d") (rev "r"))
  (lib_symbols)
  ${body}
  (sheet_instances (path "/" (page "1")))
)`;
}

async function scored(body: string) {
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-score-'));
  const file = path.join(dir, 'x.kicad_sch');
  await writeFile(file, sch(body), 'utf8');
  const report = await scoreSchematic(file);
  await rm(dir, { recursive: true, force: true });
  return report;
}

const metric = (r: Awaited<ReturnType<typeof scored>>, name: string) => r.metrics.find((m) => m.name === name)!;

describe('scorer metrics: hand-computed values', () => {
  it('counts one proper crossing and zero for a shared-endpoint join', async () => {
    const crossing = await scored(`
      (wire (pts (xy 50 100) (xy 100 100)) (stroke (width 0) (type default)) (uuid "5c0e0000-0000-4000-8000-00000000w001"))
      (wire (pts (xy 75 80) (xy 75 120)) (stroke (width 0) (type default)) (uuid "5c0e0000-0000-4000-8000-00000000w002"))`);
    expect(metric(crossing, 'wire-crossings').raw).toBe(1);
    expect(metric(crossing, 'wire-crossings').score).toBe(0.5); // 1/(1+1)

    const joined = await scored(`
      (wire (pts (xy 50 100) (xy 75 100)) (stroke (width 0) (type default)) (uuid "5c0e0000-0000-4000-8000-00000000w001"))
      (wire (pts (xy 75 100) (xy 75 120)) (stroke (width 0) (type default)) (uuid "5c0e0000-0000-4000-8000-00000000w002"))`);
    expect(metric(joined, 'wire-crossings').raw).toBe(0);
  });

  it('counts a bend where two segments of different orientation meet', async () => {
    const r = await scored(`
      (wire (pts (xy 50 100) (xy 75 100)) (stroke (width 0) (type default)) (uuid "5c0e0000-0000-4000-8000-00000000w001"))
      (wire (pts (xy 75 100) (xy 75 120)) (stroke (width 0) (type default)) (uuid "5c0e0000-0000-4000-8000-00000000w002"))`);
    expect(metric(r, 'wire-bends').raw).toBe(1);
    expect(metric(r, 'wire-length').raw).toBeCloseTo(45, 5); // 25 + 20
    expect(metric(r, 'straight-wire-ratio').raw).toBe(0.5); // 1 bend / 2 segments
  });

  it('measures label alignment as the horizontal fraction', async () => {
    const r = await scored(`
      (label "A" (at 50 100 0) (effects (font (size 1.27 1.27))) (uuid "5c0e0000-0000-4000-8000-00000000l001"))
      (label "B" (at 60 100 90) (effects (font (size 1.27 1.27))) (uuid "5c0e0000-0000-4000-8000-00000000l002"))`);
    expect(metric(r, 'label-alignment').raw).toBe(0.5);
  });

  it('group cohesion degrades with same-net label separation', async () => {
    const near = await scored(`
      (label "N" (at 50 100 0) (effects (font (size 1.27 1.27))) (uuid "5c0e0000-0000-4000-8000-00000000l001"))
      (label "N" (at 60 100 0) (effects (font (size 1.27 1.27))) (uuid "5c0e0000-0000-4000-8000-00000000l002"))`);
    const far = await scored(`
      (label "N" (at 20 20 0) (effects (font (size 1.27 1.27))) (uuid "5c0e0000-0000-4000-8000-00000000l001"))
      (label "N" (at 280 190 0) (effects (font (size 1.27 1.27))) (uuid "5c0e0000-0000-4000-8000-00000000l002"))`);
    expect(metric(near, 'group-cohesion').raw).toBeCloseTo(10, 5);
    expect(metric(far, 'group-cohesion').score).toBeLessThan(metric(near, 'group-cohesion').score);
  });

  it('the composite is the weighted contribution sum, reproducibly (AC-16.14)', async () => {
    // grid-true coordinates: an off-grid error would cap the composite and
    // decouple it from the contribution sum
    const body = `
      (label "A" (at 50.8 101.6 0) (effects (font (size 1.27 1.27))) (uuid "5c0e0000-0000-4000-8000-00000000l001"))
      (label "A" (at 60.96 101.6 0) (effects (font (size 1.27 1.27))) (uuid "5c0e0000-0000-4000-8000-00000000l002"))`;
    const a = await scored(body);
    const b = await scored(body);
    expect(a.cap).toBeNull();
    expect(a.composite).toBe(b.composite);
    expect(a.composite).toBeCloseTo(
      a.metrics.reduce((s, m) => s + m.contribution, 0),
      2,
    );
    expect(a.metrics.map((m) => m.name).sort()).toEqual(b.metrics.map((m) => m.name).sort());
  });

  it('weights are configurable and zeroing one removes its contribution', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-scorew-'));
    const file = path.join(dir, 'x.kicad_sch');
    await writeFile(
      file,
      sch(`(wire (pts (xy 50 100) (xy 100 100)) (stroke (width 0) (type default)) (uuid "5c0e0000-0000-4000-8000-00000000w001"))
      (wire (pts (xy 75 80) (xy 75 120)) (stroke (width 0) (type default)) (uuid "5c0e0000-0000-4000-8000-00000000w002"))`),
      'utf8',
    );
    const tuned = await scoreSchematic(file, { config: { score: { weights: { 'wire-crossings': 0 } } } });
    await rm(dir, { recursive: true, force: true });
    expect(tuned.metrics.find((m) => m.name === 'wire-crossings')!.contribution).toBe(0);
  });
});