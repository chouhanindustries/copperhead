/**
 * Live KiCad IPC tests (AC-114.7): run only under COPPERHEAD_TEST_KICAD_IPC=1
 * with a real KiCad open (API server enabled in preferences). This is the
 * suite that validates the hand-built nng framing and the vendored proto tag
 * against the real implementation; it also records response captures into
 * test/fixtures/kicad-ipc/ for offline drift comparison (re-record when
 * bumping src/kicad/proto/VERSION).
 */

import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KicadBridge, discoverKicadAddress } from '../src/kicad/ipc.js';

const enabled = process.env.COPPERHEAD_TEST_KICAD_IPC === '1';
const FIXDIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'kicad-ipc');

describe.skipIf(!enabled)('live KiCad IPC (COPPERHEAD_TEST_KICAD_IPC=1)', () => {
  it('connects to the running KiCad, reads documents and selection', async () => {
    const bridge = new KicadBridge({ connectTimeoutMs: 2000, requestTimeoutMs: 5000, reprobeMs: 0 });
    try {
      bridge.start();
      const start = Date.now();
      while (!bridge.isConnected && Date.now() - start < 5000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(bridge.isConnected, `no KiCad API server at ${discoverKicadAddress()?.address}; open a board and enable the API in preferences`).toBe(true);
      expect(bridge.version).toBeTruthy();

      const docs = await bridge.getOpenDocuments();
      expect(Array.isArray(docs)).toBe(true);
      const selection = await bridge.getSelection();
      expect(Array.isArray(selection)).toBe(true);

      // Drift capture: what the real KiCad reported, for eyeballing against
      // the fake server's shapes when the pinned proto tag changes.
      await mkdir(FIXDIR, { recursive: true });
      await writeFile(
        path.join(FIXDIR, 'live-capture.json'),
        JSON.stringify({ kicad: bridge.version, docs, selection }, null, 2) + '\n',
        'utf8',
      );
    } finally {
      bridge.stop();
    }
  }, 20000);
});
