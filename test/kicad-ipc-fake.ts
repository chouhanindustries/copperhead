/**
 * Fake KiCad IPC server (D7): speaks the same nng REP0 wire protocol the real
 * KiCad API server does — SP handshake, in-band frames, request-id echo,
 * protobuf ApiRequest/ApiResponse envelope built from the same vendored
 * .proto files — over a temp-dir Unix socket. Every offline bridge scenario
 * (AC-114.*) runs against this; the COPPERHEAD_TEST_KICAD_IPC=1 suite is what
 * validates the framing against a real KiCad.
 */

import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadProtoRoot } from '../src/kicad/ipc.js';
import type protobuf from 'protobufjs';

const SP_HEADER_REP = Buffer.from([0x00, 0x53, 0x50, 0x00, 0x00, 0x31, 0x00, 0x00]);
const ANY_PREFIX = 'type.googleapis.com/';

export interface FakeKicadOptions {
  /** Reported by GetVersion. */
  version?: string;
  /** Open pcb documents (board filenames). */
  boards?: string[];
  /** Selection returned for GetSelection: raw kiapi.board.types payloads. */
  selection?: Array<{ typeName: string; payload: Record<string, unknown> }>;
  /** Respond to every request with this status instead of AS_OK. */
  failWith?: string;
  /** Send garbage instead of a valid handshake (malformed-peer scenario). */
  badHandshake?: boolean;
  /** Never answer requests (timeout scenario). */
  mute?: boolean;
}

export class FakeKicadServer {
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  private dir: string | null = null;
  private root!: protobuf.Root;
  /** Every accepted connection, including ones that fail the handshake (AC-114.6). */
  connections = 0;
  /** type names of requests received, in order. */
  requests: string[] = [];
  socketPath = '';

  constructor(private opts: FakeKicadOptions = {}) {}

  /** Update behavior mid-test (e.g. selection changes between turns). */
  set(opts: Partial<FakeKicadOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  async start(atPath?: string): Promise<string> {
    this.root = await loadProtoRoot();
    if (atPath) {
      this.socketPath = atPath;
    } else {
      this.dir = await mkdtemp(path.join(tmpdir(), 'copperhead-fake-kicad-'));
      this.socketPath = path.join(this.dir, 'api.sock');
    }
    this.server = net.createServer((socket) => this.handle(socket));
    await new Promise<void>((resolve) => this.server!.listen(this.socketPath, resolve));
    return this.socketPath;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
    this.dir = null;
  }

  /** Drop all live connections without stopping the listener (mid-run death). */
  killConnections(): void {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }

  private handle(socket: net.Socket): void {
    this.connections++;
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => {});
    if (this.opts.badHandshake) {
      socket.write(Buffer.from('definitely not an SP handshake'));
      return;
    }
    let buf = Buffer.alloc(0);
    let handshaken = false;
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshaken) {
        if (buf.length < 8) return;
        buf = buf.subarray(8); // trust the client header; the real server validates
        handshaken = true;
        socket.write(SP_HEADER_REP);
      }
      while (buf.length >= 9) {
        const len = Number(buf.readBigUInt64BE(1));
        if (buf.length < 9 + len) return;
        const payload = buf.subarray(9, 9 + len);
        buf = buf.subarray(9 + len);
        if (this.opts.mute) continue;
        const reqId = payload.readUInt32BE(0);
        const reply = this.reply(Buffer.from(payload.subarray(4)));
        const frame = Buffer.alloc(9 + 4 + reply.length);
        frame[0] = 0x01;
        frame.writeBigUInt64BE(BigInt(4 + reply.length), 1);
        frame.writeUInt32BE(reqId, 9);
        frame.set(reply, 13);
        socket.write(frame);
      }
    });
  }

  private pack(typeName: string, payload: Record<string, unknown>): { type_url: string; value: Uint8Array } {
    const type = this.root.lookupType(typeName);
    return { type_url: ANY_PREFIX + typeName, value: type.encode(type.fromObject(payload)).finish() };
  }

  private respond(status: string, message?: { type_url: string; value: Uint8Array }): Buffer {
    const ApiResponse = this.root.lookupType('kiapi.common.ApiResponse');
    return Buffer.from(
      ApiResponse.encode(
        ApiResponse.fromObject({
          header: { kicadToken: 'fake-token' },
          status: { status, errorMessage: status === 'AS_OK' ? '' : `fake server: ${status}` },
          ...(message ? { message } : {}),
        }),
      ).finish(),
    );
  }

  private reply(body: Buffer): Buffer {
    const ApiRequest = this.root.lookupType('kiapi.common.ApiRequest');
    let typeName = '';
    let inner: Record<string, unknown> = {};
    try {
      const req = ApiRequest.toObject(ApiRequest.decode(body), { enums: String }) as {
        message?: { type_url?: string; value?: Uint8Array };
      };
      const url = req.message?.type_url ?? '';
      typeName = url.startsWith(ANY_PREFIX) ? url.slice(ANY_PREFIX.length) : url;
      const innerType = this.root.lookupType(typeName);
      inner = innerType.toObject(innerType.decode(req.message?.value ?? new Uint8Array()), {
        enums: String,
      }) as Record<string, unknown>;
    } catch {
      return this.respond('AS_BAD_REQUEST');
    }
    this.requests.push(typeName);
    if (this.opts.failWith) return this.respond(this.opts.failWith);

    switch (typeName) {
      case 'kiapi.common.commands.GetVersion': {
        const full = this.opts.version ?? '10.0.5';
        const [major = 0, minor = 0, patch = 0] = full.split('.').map((n) => Number(n) || 0);
        return this.respond(
          'AS_OK',
          this.pack('kiapi.common.commands.GetVersionResponse', {
            version: { major, minor, patch, fullVersion: full },
          }),
        );
      }
      case 'kiapi.common.commands.Ping':
        return this.respond('AS_OK');
      case 'kiapi.common.commands.GetOpenDocuments': {
        // The real KiCad 9/10 API server lives in pcbnew only: schematic
        // queries come back AS_UNHANDLED, which the bridge must treat as
        // "no schematic docs", not as a failure (feature detection, 2.4).
        if (inner.type !== 'DOCTYPE_PCB') return this.respond('AS_UNHANDLED');
        return this.respond(
          'AS_OK',
          this.pack('kiapi.common.commands.GetOpenDocumentsResponse', {
            documents: (this.opts.boards ?? []).map((b) => ({
              type: 'DOCTYPE_PCB',
              boardFilename: b,
              project: { name: path.basename(b, '.kicad_pcb'), path: '/tmp/fake-project' },
            })),
          }),
        );
      }
      case 'kiapi.common.commands.GetSelection': {
        return this.respond(
          'AS_OK',
          this.pack('kiapi.common.commands.SelectionResponse', {
            items: (this.opts.selection ?? []).map((s) => this.pack(s.typeName, s.payload)),
          }),
        );
      }
      default:
        return this.respond('AS_UNIMPLEMENTED');
    }
  }
}

/** Selection payload builders for tests: just enough structure to carry the facts. */
export function fakeFootprint(reference: string, value: string): {
  typeName: string;
  payload: Record<string, unknown>;
} {
  return {
    typeName: 'kiapi.board.types.FootprintInstance',
    payload: {
      referenceField: { name: 'Reference', text: { text: { text: reference } } },
      valueField: { name: 'Value', text: { text: { text: value } } },
    },
  };
}

export function fakeTrack(netName: string): { typeName: string; payload: Record<string, unknown> } {
  return { typeName: 'kiapi.board.types.Track', payload: { net: { name: netName } } };
}
