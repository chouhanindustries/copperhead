/**
 * KiCad IPC bridge: connection lifecycle and read-only calls against the fake
 * nng REP0 server (AC-114.1, AC-114.5, AC-114.7). No KiCad required.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  KicadBridge,
  describeSelection,
  discoverKicadAddress,
  socketPathOf,
} from '../src/kicad/ipc.js';
import { FakeKicadServer, fakeFootprint, fakeTrack } from './kicad-ipc-fake.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function bridgeFor(address: string, extra: ConstructorParameters<typeof KicadBridge>[0] = {}): {
  bridge: KicadBridge;
  states: boolean[];
} {
  const states: boolean[] = [];
  const bridge = new KicadBridge({
    address,
    reprobeMs: 50,
    connectTimeoutMs: 250,
    requestTimeoutMs: 500,
    onStateChange: (c) => states.push(c),
    ...extra,
  });
  cleanups.push(() => bridge.stop());
  return { bridge, states };
}

async function serverFor(opts: ConstructorParameters<typeof FakeKicadServer>[0] = {}): Promise<FakeKicadServer> {
  const server = new FakeKicadServer(opts);
  await server.start();
  cleanups.push(() => server.stop());
  return server;
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await sleep(10);
  }
}

describe('discovery (D2)', () => {
  it('prefers KICAD_API_SOCKET + token env vars', () => {
    const found = discoverKicadAddress({
      KICAD_API_SOCKET: 'ipc:///run/kicad/api.sock',
      KICAD_API_TOKEN: 'tok-123',
    } as NodeJS.ProcessEnv);
    expect(found).toEqual({ address: 'ipc:///run/kicad/api.sock', token: 'tok-123' });
  });

  it('falls back to the well-known path with no token', () => {
    const found = discoverKicadAddress({} as NodeJS.ProcessEnv);
    expect(found?.address).toBeTruthy();
    expect(found?.token).toBeNull();
  });

  it('strips the ipc:// scheme to a plain socket path', () => {
    expect(socketPathOf('ipc:///tmp/kicad/api.sock')).toBe('/tmp/kicad/api.sock');
    expect(socketPathOf('/tmp/kicad/api.sock')).toBe('/tmp/kicad/api.sock');
  });
});

describe('connection lifecycle (AC-114.1, AC-114.5)', () => {
  it('connects to a running server and negotiates the version', async () => {
    const server = await serverFor({ version: '10.0.5' });
    const { bridge, states } = bridgeFor(server.socketPath);
    bridge.start();
    await until(() => bridge.isConnected);
    expect(bridge.version).toBe('10.0.5');
    expect(states).toEqual([true]);
    expect(server.requests).toContain('kiapi.common.commands.GetVersion');
  });

  it('stays disconnected with no socket, without blocking start()', async () => {
    const { bridge, states } = bridgeFor('/nonexistent/dir/api.sock', { reprobeMs: 0 });
    const before = Date.now();
    bridge.start();
    expect(Date.now() - before).toBeLessThan(50); // start() never blocks
    await sleep(100);
    expect(bridge.isConnected).toBe(false);
    expect(states).toEqual([]);
  });

  it('re-probes and connects to a KiCad started after the bridge', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-late-kicad-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const address = path.join(dir, 'api.sock');
    const { bridge } = bridgeFor(address);
    bridge.start();
    await sleep(120); // a few probes against the missing socket
    expect(bridge.isConnected).toBe(false);
    const server = new FakeKicadServer();
    cleanups.push(() => server.stop());
    await server.start(address); // "the user starts KiCad"
    await until(() => bridge.isConnected);
    expect(bridge.version).toBe('10.0.5');
  });

  it('maps a mid-session disconnect to a soft error and the disconnected state', async () => {
    const server = await serverFor({ boards: ['keyer.kicad_pcb'] });
    const { bridge, states } = bridgeFor(server.socketPath, { reprobeMs: 0 });
    bridge.start();
    await until(() => bridge.isConnected);
    server.set({ mute: true }); // next request hangs, then the server dies
    const pending = bridge.getOpenDocuments();
    server.killConnections();
    await expect(pending).rejects.toThrow(/closed|timed out|not connected/);
    await until(() => !bridge.isConnected);
    expect(states).toEqual([true, false]);
  });

  it('treats a malformed peer as disconnected, not an exception', async () => {
    const server = await serverFor({ badHandshake: true });
    const { bridge, states } = bridgeFor(server.socketPath, { reprobeMs: 0 });
    bridge.start();
    await sleep(400);
    expect(bridge.isConnected).toBe(false);
    expect(states).toEqual([]);
  });

  it('treats a request timeout as a connection reset', async () => {
    const server = await serverFor();
    const { bridge } = bridgeFor(server.socketPath, { reprobeMs: 0, requestTimeoutMs: 100 });
    bridge.start();
    await until(() => bridge.isConnected);
    server.set({ mute: true });
    await expect(bridge.getOpenDocuments()).rejects.toThrow(/timed out/);
    await until(() => !bridge.isConnected);
  });
});

describe('read-only calls', () => {
  it('lists open pcb documents and tolerates the unimplemented schematic doctype', async () => {
    const server = await serverFor({ boards: ['keyer.kicad_pcb'] });
    const { bridge } = bridgeFor(server.socketPath);
    bridge.start();
    await until(() => bridge.isConnected);
    const docs = await bridge.getOpenDocuments();
    expect(docs).toEqual([
      {
        type: 'pcb',
        name: 'keyer.kicad_pcb',
        projectName: 'keyer',
        projectPath: '/tmp/fake-project',
      },
    ]);
  });

  it('decodes footprint references/values and track nets from the selection', async () => {
    const server = await serverFor({
      boards: ['keyer.kicad_pcb'],
      selection: [fakeFootprint('C3', '100nF'), fakeTrack('/VBUS')],
    });
    const { bridge } = bridgeFor(server.socketPath);
    bridge.start();
    await until(() => bridge.isConnected);
    const sel = await bridge.getSelection();
    expect(sel).toEqual([
      { kind: 'footprint', reference: 'C3', value: '100nF', net: null },
      { kind: 'track', reference: null, value: null, net: '/VBUS' },
    ]);
    expect(describeSelection(sel)).toEqual(['footprint C3 (100nF)', 'track net /VBUS']);
  });

  it('returns an empty selection when no board is open', async () => {
    const server = await serverFor({ boards: [] });
    const { bridge } = bridgeFor(server.socketPath);
    bridge.start();
    await until(() => bridge.isConnected);
    expect(await bridge.getSelection()).toEqual([]);
  });

  it('reports which touched board file is open in KiCad (reload prompt input)', async () => {
    const server = await serverFor({ boards: ['keyer.kicad_pcb'] });
    const { bridge } = bridgeFor(server.socketPath);
    bridge.start();
    await until(() => bridge.isConnected);
    expect(await bridge.openBoardTouchedBy(['hw/keyer.kicad_pcb', 'docs/BOM.md'])).toBe('hw/keyer.kicad_pcb');
    expect(await bridge.openBoardTouchedBy(['other.kicad_pcb'])).toBeNull();
    expect(await bridge.openBoardTouchedBy(['docs/BOM.md'])).toBeNull();
  });

  it('surfaces a non-OK API status as a bridge error', async () => {
    const server = await serverFor({ failWith: 'AS_TOKEN_MISMATCH' });
    const { bridge } = bridgeFor(server.socketPath, { reprobeMs: 0 });
    bridge.start();
    await sleep(400);
    // GetVersion fails during negotiation, so the bridge never reports connected.
    expect(bridge.isConnected).toBe(false);
  });
});
