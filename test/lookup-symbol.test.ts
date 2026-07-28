import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/agent/tools.js';
import { symbolSearchDirs } from '../src/kicad/symlib.js';

const tool = TOOLS.find((t) => t.schema.name === 'lookup_symbol')!;
const noLibs = (await symbolSearchDirs()).length === 0;

describe('lookup_symbol tool', () => {
  it('is available without an unlock (it is read-only)', () => {
    expect(tool).toBeDefined();
    expect(tool.requiresUnlock).toBe(false);
  });

  it('rejects a non lib_id', async () => {
    expect(await tool.handler({} as never, { lib_id: 'R' })).toMatch(/not a lib_id/);
  });

  it.skipIf(noLibs)('returns the real pin table for a canonical part', async () => {
    const out = await tool.handler({} as never, { lib_id: 'Device:R' });
    expect(out).toMatch(/Device:R has 2 pin/);
  });

  it.skipIf(noLibs)('suggests closest names when the symbol is absent', async () => {
    const out = await tool.handler({} as never, { lib_id: 'RF_Module:ESP32-C3-MINI-1' });
    expect(out).toMatch(/not found|Closest real symbols/);
  });
});
