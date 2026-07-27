/**
 * KiCad bridge ↔ agent integration, offline (AC-114.2 through AC-114.6):
 * connection-gated tools, selection injection, mid-run disconnect, the reload
 * prompt, and command isolation. All against the fake IPC server.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { runAgentLoop } from '../src/agent/loop.js';
import { runRepl } from '../src/commands/repl.js';
import { plainRenderer } from '../src/agent/render.js';
import { setColorEnabled } from '../src/agent/theme.js';
import { availableTools, type RunContext } from '../src/agent/tools.js';
import type { Msg, Provider, ToolSchema, Turn } from '../src/agent/types.js';
import { KicadBridge, kicadReloadNote } from '../src/kicad/ipc.js';
import { runCheck } from '../src/commands/check.js';
import { syncVerify } from '../src/commands/sync.js';
import { tempFixtureRepo } from './helpers.js';
import { FakeKicadServer, fakeFootprint } from './kicad-ipc-fake.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function connectedBridge(server: FakeKicadServer): Promise<KicadBridge> {
  const bridge = new KicadBridge({
    address: server.socketPath,
    reprobeMs: 0,
    requestTimeoutMs: 300,
  });
  cleanups.push(() => bridge.stop());
  bridge.start();
  const start = Date.now();
  while (!bridge.isConnected) {
    if (Date.now() - start > 2000) throw new Error('bridge never connected');
    await new Promise((r) => setTimeout(r, 10));
  }
  return bridge;
}

async function serverFor(opts: ConstructorParameters<typeof FakeKicadServer>[0] = {}): Promise<FakeKicadServer> {
  const server = new FakeKicadServer(opts);
  await server.start();
  cleanups.push(() => server.stop());
  return server;
}

/** Finishes on the first turn; records the tool list and messages each turn. */
class CapturingProvider implements Provider {
  readonly name = 'scripted';
  toolNames: string[][] = [];
  messages: Msg[][] = [];
  private i = 0;
  constructor(private readonly turns: Turn[]) {}
  async chat(messages: Msg[], tools: ToolSchema[]): Promise<Turn> {
    this.messages.push(messages.map((m) => ({ ...m })));
    this.toolNames.push(tools.map((t) => t.name));
    const t = this.turns[Math.min(this.i, this.turns.length - 1)]!;
    this.i++;
    return t;
  }
}

const finishTurn: Turn = {
  text: null,
  toolCalls: [{ id: 'fin', name: 'finish', args: { outcome: 'done', summary: 'noop' } }],
  usage: { inputTokens: 10, outputTokens: 5 },
};

async function transcriptEvents(dir: string): Promise<{ type: string; data: Record<string, unknown> }[]> {
  const raw = await readFile(path.join(dir, 'transcript.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown> });
}

describe('connection-gated tools (AC-114.2)', () => {
  it('offers get_kicad_selection/get_open_documents only while connected', async () => {
    const server = await serverFor({ boards: ['open-key.kicad_pcb'] });
    const bridge = await connectedBridge(server);
    const { repo, cleanup } = await tempFixtureRepo();
    cleanups.push(cleanup);

    const connected = new CapturingProvider([finishTurn]);
    await runAgentLoop({ repoRoot: repo, request: 'noop', model: 'gpt-5', provider: connected, kicad: bridge, log: () => {} });
    expect(connected.toolNames[0]).toContain('get_kicad_selection');
    expect(connected.toolNames[0]).toContain('get_open_documents');

    const detached = new CapturingProvider([finishTurn]);
    await runAgentLoop({ repoRoot: repo, request: 'noop', model: 'gpt-5', provider: detached, log: () => {} });
    expect(detached.toolNames[0]).not.toContain('get_kicad_selection');
    expect(detached.toolNames[0]).not.toContain('get_open_documents');
  });

  it('availableTools drops the kicad tools when the bridge reports disconnected', () => {
    const disconnected = { isConnected: false } as KicadBridge;
    const base = { editsUnlocked: false, kicad: null } as unknown as RunContext;
    const withBridge = { editsUnlocked: false, kicad: disconnected } as unknown as RunContext;
    for (const ctx of [base, withBridge]) {
      expect(availableTools(ctx).map((t) => t.schema.name)).not.toContain('get_kicad_selection');
    }
  });
});

describe('selection injection (AC-114.3)', () => {
  it('injects a labeled selection block with references and nets', async () => {
    const server = await serverFor({
      boards: ['open-key.kicad_pcb'],
      selection: [fakeFootprint('C3', '100nF')],
    });
    const bridge = await connectedBridge(server);
    const { repo, cleanup } = await tempFixtureRepo();
    cleanups.push(cleanup);

    const provider = new CapturingProvider([finishTurn]);
    const res = await runAgentLoop({ repoRoot: repo, request: 'move this cap', model: 'gpt-5', provider, kicad: bridge, log: () => {} });
    const user = provider.messages[0]!.find((m) => m.role === 'user')!;
    expect(user.content).toContain('move this cap');
    expect(user.content).toContain('## KiCad selection');
    expect(user.content).toContain('footprint C3 (100nF)');

    const events = await transcriptEvents(res.transcriptDir);
    expect(events.some((e) => e.type === 'kicad-selection')).toBe(true);
  });

  it('injects nothing when the selection is empty', async () => {
    const server = await serverFor({ boards: ['open-key.kicad_pcb'], selection: [] });
    const bridge = await connectedBridge(server);
    const { repo, cleanup } = await tempFixtureRepo();
    cleanups.push(cleanup);

    const provider = new CapturingProvider([finishTurn]);
    const res = await runAgentLoop({ repoRoot: repo, request: 'noop', model: 'gpt-5', provider, kicad: bridge, log: () => {} });
    const user = provider.messages[0]!.find((m) => m.role === 'user')!;
    expect(user.content).not.toContain('KiCad selection');
    const events = await transcriptEvents(res.transcriptDir);
    expect(events.some((e) => e.type === 'kicad-selection')).toBe(false);
  });
});

describe('mid-run disconnect (AC-114.5)', () => {
  it('turns an in-flight call into a soft error and drops the tools next turn', async () => {
    const server = await serverFor({ boards: ['open-key.kicad_pcb'] });
    const bridge = await connectedBridge(server);
    const { repo, cleanup } = await tempFixtureRepo();
    cleanups.push(cleanup);

    class DisconnectingProvider extends CapturingProvider {
      override async chat(messages: Msg[], tools: ToolSchema[]): Promise<Turn> {
        const turn = await super.chat(messages, tools);
        // "KiCad exits" right before the first turn's tool call executes.
        if (this.toolNames.length === 1) server.set({ mute: true });
        return turn;
      }
    }
    const provider = new DisconnectingProvider([
      {
        text: null,
        toolCalls: [{ id: 't1', name: 'get_kicad_selection', args: {} }],
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      finishTurn,
    ]);

    const res = await runAgentLoop({ repoRoot: repo, request: 'noop', model: 'gpt-5', provider, kicad: bridge, log: () => {} });
    expect(res.outcome).toBe('success'); // the run survives the dead bridge

    const events = await transcriptEvents(res.transcriptDir);
    const toolEvent = events.find((e) => e.type === 'tool' && e.data.name === 'get_kicad_selection')!;
    expect(String(toolEvent.data.result)).toMatch(/kicad bridge error|not connected/);
    // Turn 2's advertised tools no longer include the kicad tools.
    expect(provider.toolNames[1]).not.toContain('get_kicad_selection');
    expect(bridge.isConnected).toBe(false);
  });
});

describe('reload prompt (AC-114.4)', () => {
  it('names a touched board that is open in KiCad', async () => {
    const server = await serverFor({ boards: ['open-key.kicad_pcb'] });
    const bridge = await connectedBridge(server);
    const note = await kicadReloadNote(bridge, ['hardware/open-key.kicad_pcb', 'docs/BOM.md']);
    expect(note).toContain('open-key.kicad_pcb is open in KiCad');
    expect(note).toContain('File > Revert');
  });

  it('stays silent for schematic-only changes, other boards, or no bridge', async () => {
    const server = await serverFor({ boards: ['open-key.kicad_pcb'] });
    const bridge = await connectedBridge(server);
    expect(await kicadReloadNote(bridge, ['hardware/open-key.kicad_sch'])).toBeNull();
    expect(await kicadReloadNote(bridge, ['other.kicad_pcb'])).toBeNull();
    expect(await kicadReloadNote(null, ['hardware/open-key.kicad_pcb'])).toBeNull();
  });

  it('maps a bridge failure to silence, not an error', async () => {
    const server = await serverFor({ boards: ['open-key.kicad_pcb'] });
    const bridge = await connectedBridge(server);
    server.set({ mute: true });
    expect(await kicadReloadNote(bridge, ['hardware/open-key.kicad_pcb'])).toBeNull();
  });
});

describe('REPL surface (AC-114.1)', () => {
  it('shows the connected kicad state in the meta row and /status', async () => {
    const server = await serverFor({ version: '10.0.5', boards: ['open-key.kicad_pcb'] });
    const bridge = await connectedBridge(server);
    setColorEnabled(false);
    const input = new PassThrough();
    const output = new PassThrough();
    (input as unknown as { isTTY: boolean }).isTTY = true;
    (output as unknown as { isTTY: boolean }).isTTY = true;
    const dockBytes: Buffer[] = [];
    output.on('data', (c: Buffer) => dockBytes.push(c));
    const lines: string[] = [];
    const done = runRepl({
      repoRoot: '/tmp/repo',
      model: 'gpt-5',
      modelSource: 'flag',
      version: '0.7.0',
      kicadCliVersion: '9.0.0',
      renderer: plainRenderer((l) => lines.push(l)),
      log: (l) => lines.push(l),
      input,
      output,
      runRequest: async () => ({ outcome: 'success' as const }),
      kicad: bridge,
    });
    await new Promise((r) => setTimeout(r, 50));
    input.write('/status\n');
    await new Promise((r) => setTimeout(r, 100));
    input.write('/quit\n');
    await done;
    expect(lines.join('\n')).toContain('connected (10.0.5)'); // /status row
    expect(Buffer.concat(dockBytes).toString()).toContain('kicad 10.0.5'); // meta row
  });

  it('shows the disconnected state without slowing startup', async () => {
    const bridge = new KicadBridge({ address: '/nonexistent/api.sock', reprobeMs: 0 });
    cleanups.push(() => bridge.stop());
    bridge.start();
    setColorEnabled(false);
    const input = new PassThrough();
    const output = new PassThrough();
    (input as unknown as { isTTY: boolean }).isTTY = true;
    (output as unknown as { isTTY: boolean }).isTTY = true;
    const dockBytes: Buffer[] = [];
    output.on('data', (c: Buffer) => dockBytes.push(c));
    const lines: string[] = [];
    const before = Date.now();
    const done = runRepl({
      repoRoot: '/tmp/repo',
      model: 'gpt-5',
      modelSource: 'flag',
      version: '0.7.0',
      kicadCliVersion: '9.0.0',
      renderer: plainRenderer((l) => lines.push(l)),
      log: (l) => lines.push(l),
      input,
      output,
      runRequest: async () => ({ outcome: 'success' as const }),
      kicad: bridge,
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(Date.now() - before).toBeLessThan(1000); // prompt is up, not blocked on the probe
    input.write('/status\n');
    await new Promise((r) => setTimeout(r, 100));
    input.write('/quit\n');
    await done;
    expect(lines.join('\n')).toContain('not connected');
    expect(Buffer.concat(dockBytes).toString()).toContain('kicad off');
  });
});

describe('command isolation (AC-114.6)', () => {
  it('check, sync verify, and a bridge-less loop never touch the socket', async () => {
    const server = await serverFor({ boards: ['open-key.kicad_pcb'] });
    const { repo, cleanup } = await tempFixtureRepo();
    cleanups.push(cleanup);

    // Even with the discovery env var pointing straight at a live server,
    // these paths must not construct a client (the bridge is wired only in
    // the REPL and `do` commands).
    const oldEnv = process.env.KICAD_API_SOCKET;
    process.env.KICAD_API_SOCKET = server.socketPath;
    cleanups.push(() => {
      if (oldEnv === undefined) delete process.env.KICAD_API_SOCKET;
      else process.env.KICAD_API_SOCKET = oldEnv;
    });

    await runCheck(repo, () => {});
    await syncVerify(repo);
    await runAgentLoop({
      repoRoot: repo,
      request: 'noop',
      model: 'gpt-5',
      provider: new CapturingProvider([finishTurn]),
      log: () => {},
    });
    expect(server.connections).toBe(0);
  });
});
