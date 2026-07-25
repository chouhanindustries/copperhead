import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/agent/tools.js';
import { footprintSearchDirs, padNumbers } from '../src/kicad/footprintlib.js';

const tool = TOOLS.find((t) => t.schema.name === 'lookup_footprint')!;
const noLibs = (await footprintSearchDirs()).length === 0;

describe('lookup_footprint tool', () => {
  it('is read-only, available without an unlock', () => {
    expect(tool.requiresUnlock).toBe(false);
  });

  it('rejects a bare name that is not a lib_id', async () => {
    expect(await tool.handler({} as never, { lib_id: 'C_0603' })).toMatch(/not a footprint lib_id/);
  });

  it('padNumbers reads numbers in file order, keeping repeats and unnamed pads', () => {
    const mod = '(footprint "X" (pad "1" smd rect) (pad "" np_thru_hole circle) (pad "2" smd rect) (pad "2" smd rect))';
    expect(padNumbers(mod)).toEqual(['1', '', '2', '2']);
  });

  it.skipIf(noLibs)('returns the real pad list for a stock footprint', async () => {
    const out = await tool.handler({} as never, {
      lib_id: 'Capacitor_SMD:C_0603_1608Metric',
      pads_only: true,
    });
    expect(out).toMatch(/2 pad entr/);
  });

  it.skipIf(noLibs)('returns the body verbatim when not pads_only', async () => {
    const out = await tool.handler({} as never, { lib_id: 'Capacitor_SMD:C_0603_1608Metric' });
    expect(out).toContain('(footprint');
    expect(out).toContain('(pad');
  });

  it.skipIf(noLibs)('suggests closest names when the footprint is absent', async () => {
    const out = await tool.handler({} as never, { lib_id: 'Capacitor_SMD:C_9999_NotReal' });
    expect(out).toMatch(/not found/);
  });
});
