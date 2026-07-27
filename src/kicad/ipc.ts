/**
 * KiCad IPC bridge (AC-114): a read-only client for the IPC API that a running
 * KiCad 9+ instance serves over a local socket. Context flows IN (open
 * documents, current selection); no mutation ever flows OUT through this
 * channel — file edits gated by kicad-cli verification remain the only
 * mutation path (SPEC.md §1.3).
 *
 * Wire protocol: KiCad's API server is an nng REP0 socket on a Unix domain
 * socket (named pipe on Windows). nng is wire-compatible with the nanomsg SP
 * mappings, so no nng binding is needed:
 *   handshake  8 bytes each way: 00 53 50 00, u16be protocol, 00 00
 *              (REQ0 = 0x30 client-side; the server announces REP0 = 0x31)
 *   frame      1 type byte (0x01 in-band) + u64be payload length + payload
 *   REQ/REP    payload starts with a u32be request id with the high bit set;
 *              the reply echoes it, then carries the protobuf ApiResponse
 * The protobuf envelope (kiapi.common.ApiRequest/ApiResponse wrapping a
 * google.protobuf.Any) is decoded with protobufjs against the .proto files
 * vendored under ./proto (pinned tag in ./proto/VERSION).
 *
 * Every failure here is soft by design (D6): callers see `null`/thrown
 * KicadBridgeError mapped to "disconnected", never a run failure.
 */

import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';

export class KicadBridgeError extends Error {}

/** One document open in the connected KiCad instance. */
export interface KicadDocumentInfo {
  type: 'pcb' | 'schematic' | 'other';
  /** Board filename for pcb docs, human-readable sheet path for schematics. */
  name: string;
  projectName: string | null;
  projectPath: string | null;
}

/** One item of the user's current editor selection, reduced to prompt-worthy facts. */
export interface KicadSelectionItem {
  /** Short kind, e.g. "footprint", "track", "via", "zone", "text". */
  kind: string;
  reference: string | null;
  value: string | null;
  net: string | null;
}

export interface KicadBridgeOptions {
  /** Socket path or ipc:// URL. Default: discovery (env vars, then well-known path). */
  address?: string;
  /** Instance token forwarded in every request header when present. */
  token?: string;
  clientName?: string;
  /** Startup/reconnect connect budget (AC-114.1: startup must not block). */
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Re-probe interval while disconnected; 0 disables re-probing. */
  reprobeMs?: number;
  /** Muted diagnostics sink; failures are logged, never thrown (D6). */
  log?: (line: string) => void;
  onStateChange?: (connected: boolean) => void;
}

/**
 * Discovery order (D2): the env vars KiCad sets for processes it launches win
 * (this is also what the Phase B panel launcher forwards), then the well-known
 * socket path an externally started KiCad listens on when the user enables the
 * API server in preferences. The well-known path is a probe target, not a
 * guarantee; a missing socket is simply "disconnected".
 */
export function discoverKicadAddress(env: NodeJS.ProcessEnv = process.env): {
  address: string;
  token: string | null;
} | null {
  const fromEnv = env.KICAD_API_SOCKET;
  if (fromEnv) return { address: fromEnv, token: env.KICAD_API_TOKEN ?? null };
  const wellKnown = process.platform === 'win32' ? '\\\\.\\pipe\\kicad' : '/tmp/kicad/api.sock';
  return { address: wellKnown, token: null };
}

/** "ipc:///tmp/kicad/api.sock" and a bare path both name the same socket. */
export function socketPathOf(address: string): string {
  return address.startsWith('ipc://') ? address.slice('ipc://'.length) : address;
}

// ---------------------------------------------------------------------------
// Vendored proto loading (D1: runtime protobufjs, no codegen build step)

const PROTO_DIR = fileURLToPath(new URL('./proto/', import.meta.url));
const PROTO_FILES = [
  'common/envelope.proto',
  'common/commands/base_commands.proto',
  'common/commands/editor_commands.proto',
  'board/board_types.proto',
];

let rootPromise: Promise<protobuf.Root> | null = null;

export function loadProtoRoot(): Promise<protobuf.Root> {
  if (!rootPromise) {
    const root = new protobuf.Root();
    // KiCad protos import by proto-root-relative path ("common/types/enums.proto").
    // google/protobuf/* imports keep their bare names so protobufjs serves its
    // bundled well-known types instead of reading files we don't vendor.
    root.resolvePath = (_origin: string, target: string): string => {
      if (target.includes('google/protobuf/')) {
        return target.slice(target.indexOf('google/protobuf/'));
      }
      return path.isAbsolute(target) ? target : path.join(PROTO_DIR, target);
    };
    rootPromise = root.load(
      PROTO_FILES.map((f) => path.join(PROTO_DIR, f)),
      { keepCase: false },
    );
  }
  return rootPromise;
}

const ANY_PREFIX = 'type.googleapis.com/';

/** protobufjs's bundled google.protobuf.Any keeps snake_case field names. */
interface AnyObj {
  type_url?: string;
  value?: Uint8Array;
}

function packAny(root: protobuf.Root, typeName: string, payload: Record<string, unknown>): AnyObj {
  const type = root.lookupType(typeName);
  // fromObject (not create): it converts enum name strings like "DOCTYPE_PCB"
  // to their wire values, matching the enums:String shape unpackAny returns.
  return { type_url: ANY_PREFIX + typeName, value: type.encode(type.fromObject(payload)).finish() };
}

function unpackAny(
  root: protobuf.Root,
  any: AnyObj | null | undefined,
): { typeName: string; message: Record<string, unknown> } | null {
  if (!any?.type_url) return null;
  const typeName = any.type_url.startsWith(ANY_PREFIX) ? any.type_url.slice(ANY_PREFIX.length) : any.type_url;
  let type: protobuf.Type;
  try {
    type = root.lookupType(typeName);
  } catch {
    // A type we didn't vendor (or a newer KiCad's addition): callers keep the
    // name and skip the body rather than failing the whole response.
    return { typeName, message: {} };
  }
  const decoded = type.decode(any.value ?? new Uint8Array());
  return {
    typeName,
    message: type.toObject(decoded, { longs: Number, enums: String }) as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// nng REQ0 socket (single connection, one request in flight)

const SP_HEADER_REQ = Buffer.from([0x00, 0x53, 0x50, 0x00, 0x00, 0x30, 0x00, 0x00]);
const REP0 = 0x31;
const FRAME_HEADER_LEN = 9; // 1 type byte + u64be length

class NngReqSocket {
  private socket: net.Socket | null = null;
  private recv = Buffer.alloc(0);
  private handshaken = false;
  private pending: {
    id: number;
    resolve: (body: Buffer) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly path: string,
    private readonly onDown: (reason: string) => void,
  ) {}

  connect(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ path: this.path });
      this.socket = socket;
      const fail = (reason: string): void => {
        socket.destroy();
        reject(new KicadBridgeError(reason));
      };
      const timer = setTimeout(() => fail(`connect timed out after ${timeoutMs}ms`), timeoutMs);
      timer.unref?.();
      socket.once('error', (err) => {
        clearTimeout(timer);
        if (!this.handshaken) fail(err.message);
      });
      socket.once('connect', () => socket.write(SP_HEADER_REQ));
      socket.on('data', (chunk) => {
        this.recv = Buffer.concat([this.recv, chunk]);
        if (!this.handshaken) {
          if (this.recv.length < 8) return;
          const hdr = this.recv.subarray(0, 8);
          this.recv = this.recv.subarray(8);
          if (hdr[0] !== 0x00 || hdr[1] !== 0x53 || hdr[2] !== 0x50 || hdr.readUInt16BE(4) !== REP0) {
            clearTimeout(timer);
            fail('peer is not an nng REP0 socket (not a KiCad API server?)');
            return;
          }
          this.handshaken = true;
          clearTimeout(timer);
          // The socket must never hold the CLI open: the bridge is an
          // accessory to the session, not a reason for the process to live.
          socket.unref?.();
          resolve();
        }
        this.drainFrames();
      });
      socket.once('close', () => this.teardown('connection closed'));
    });
  }

  private drainFrames(): void {
    while (this.handshaken && this.recv.length >= FRAME_HEADER_LEN) {
      if (this.recv[0] !== 0x01) {
        this.teardown('protocol error: unknown frame type');
        return;
      }
      const len = Number(this.recv.readBigUInt64BE(1));
      if (this.recv.length < FRAME_HEADER_LEN + len) return;
      const payload = this.recv.subarray(FRAME_HEADER_LEN, FRAME_HEADER_LEN + len);
      this.recv = this.recv.subarray(FRAME_HEADER_LEN + len);
      if (payload.length < 4) continue;
      const id = payload.readUInt32BE(0) & 0x7fffffff;
      const p = this.pending;
      if (p && p.id === id) {
        this.pending = null;
        clearTimeout(p.timer);
        p.resolve(Buffer.from(payload.subarray(4)));
      }
      // A stale id (reply to a request we already timed out) is dropped.
    }
  }

  /** One request in flight at a time: REQ0 semantics, enforced by the caller's queue. */
  request(body: Uint8Array, timeoutMs: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.closed || !this.handshaken) {
        reject(new KicadBridgeError('not connected'));
        return;
      }
      const id = this.nextId++ & 0x7fffffff || 1;
      const frame = Buffer.alloc(FRAME_HEADER_LEN + 4 + body.length);
      frame[0] = 0x01;
      frame.writeBigUInt64BE(BigInt(4 + body.length), 1);
      frame.writeUInt32BE((id | 0x80000000) >>> 0, FRAME_HEADER_LEN);
      frame.set(body, FRAME_HEADER_LEN + 4);
      const timer = setTimeout(() => {
        // A REQ socket that missed a reply is in an unknown state; reset the
        // connection rather than risk pairing the next reply with the wrong call.
        this.teardown(`request timed out after ${timeoutMs}ms`);
      }, timeoutMs);
      timer.unref?.();
      this.pending = { id, resolve, reject, timer };
      this.socket.write(frame);
    });
  }

  private teardown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const p = this.pending;
    this.pending = null;
    if (p) {
      clearTimeout(p.timer);
      p.reject(new KicadBridgeError(reason));
    }
    this.socket?.destroy();
    this.socket = null;
    this.onDown(reason);
  }

  close(): void {
    this.teardown('closed');
  }
}

// ---------------------------------------------------------------------------
// The bridge: lifecycle + high-level read-only calls

const DOCTYPE_SCHEMATIC = 'DOCTYPE_SCHEMATIC';
const DOCTYPE_PCB = 'DOCTYPE_PCB';

export class KicadBridge {
  private readonly address: string;
  private readonly token: string | null;
  private readonly clientName: string;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly reprobeMs: number;
  private readonly log: (line: string) => void;
  private readonly onStateChange: (connected: boolean) => void;

  private socket: NngReqSocket | null = null;
  private connected = false;
  private stopped = false;
  private reprobeTimer: NodeJS.Timeout | null = null;
  private probing: Promise<void> | null = null;
  /** Serializes calls: nng REQ0 handles one request at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  /** KiCad's reported version once negotiated, e.g. "10.0.5". */
  version: string | null = null;

  constructor(opts: KicadBridgeOptions = {}) {
    const discovered = discoverKicadAddress();
    this.address = socketPathOf(opts.address ?? discovered?.address ?? '');
    this.token = opts.token ?? discovered?.token ?? null;
    this.clientName = opts.clientName ?? `sh.copperhead.cli-${process.pid}`;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 250;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 2000;
    this.reprobeMs = opts.reprobeMs ?? 5000;
    this.log = opts.log ?? (() => {});
    this.onStateChange = opts.onStateChange ?? (() => {});
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** A disconnected episode re-probes every few seconds; say each thing once. */
  private lastNote = '';
  private note(line: string): void {
    if (line === this.lastNote) return;
    this.lastNote = line;
    this.log(line);
  }

  /**
   * Kick off the first probe and the slow re-probe loop. Never blocks and
   * never throws: a REPL with no KiCad running starts exactly as fast, and
   * a KiCad started later is picked up by the next probe (AC-114.1).
   */
  start(): void {
    this.stopped = false;
    void this.probe();
  }

  stop(): void {
    this.stopped = true;
    if (this.reprobeTimer) clearTimeout(this.reprobeTimer);
    this.reprobeTimer = null;
    this.socket?.close();
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.onStateChange(connected);
  }

  private scheduleReprobe(): void {
    if (this.stopped || this.reprobeMs <= 0 || this.reprobeTimer) return;
    this.reprobeTimer = setTimeout(() => {
      this.reprobeTimer = null;
      void this.probe();
    }, this.reprobeMs);
    this.reprobeTimer.unref?.();
  }

  private probe(): Promise<void> {
    this.probing ??= this.probeOnce().finally(() => {
      this.probing = null;
    });
    return this.probing;
  }

  private async probeOnce(): Promise<void> {
    if (this.stopped || this.connected || !this.address) return;
    // A Unix socket that isn't on disk can't be connectable; skip the attempt
    // entirely so an idle REPL with no KiCad does nothing but one stat per probe.
    const isPipe = this.address.startsWith('\\\\');
    if (!isPipe && !existsSync(this.address)) {
      this.scheduleReprobe();
      return;
    }
    const socket = new NngReqSocket(this.address, (reason) => {
      if (this.socket === socket) {
        this.socket = null;
        this.setConnected(false);
        this.note(`kicad: disconnected (${reason})`);
        this.scheduleReprobe();
      }
    });
    try {
      await socket.connect(this.connectTimeoutMs);
      this.socket = socket;
      // Version negotiation doubles as the handshake sanity check (2.4): a
      // peer that can't answer GetVersion is not a usable API server.
      const version = await this.rawCall(socket, 'kiapi.common.commands.GetVersion', {});
      const v = (version?.version ?? {}) as { fullVersion?: string; major?: number; minor?: number; patch?: number };
      this.version = v.fullVersion || [v.major, v.minor, v.patch].filter((n) => n !== undefined).join('.') || 'unknown';
      this.setConnected(true);
      this.note(`kicad: connected (${this.version})`);
    } catch (err) {
      socket.close();
      if (this.socket === socket) this.socket = null;
      this.note(`kicad: not connected (${(err as Error).message})`);
      this.scheduleReprobe();
    }
  }

  /** Encode ApiRequest → REQ frame → decode ApiResponse, unwrap the Any. */
  private async rawCall(
    socket: NngReqSocket,
    typeName: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const root = await loadProtoRoot();
    const ApiRequest = root.lookupType('kiapi.common.ApiRequest');
    const ApiResponse = root.lookupType('kiapi.common.ApiResponse');
    const req = ApiRequest.create({
      header: { kicadToken: this.token ?? '', clientName: this.clientName },
      message: packAny(root, typeName, payload),
    });
    const raw = await socket.request(ApiRequest.encode(req).finish(), this.requestTimeoutMs);
    const res = ApiResponse.toObject(ApiResponse.decode(raw), { longs: Number, enums: String }) as {
      status?: { status?: string; errorMessage?: string };
      message?: AnyObj;
    };
    const status = res.status?.status ?? 'AS_UNKNOWN';
    if (status !== 'AS_OK') {
      throw new KicadBridgeError(`${typeName.split('.').pop()} → ${status}${res.status?.errorMessage ? `: ${res.status.errorMessage}` : ''}`);
    }
    return unpackAny(root, res.message)?.message ?? {};
  }

  /** All public calls run through here: serialized, and mapped to a soft error when down. */
  private call(typeName: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const run = this.queue.then(async () => {
      const socket = this.socket;
      if (!socket || !this.connected) throw new KicadBridgeError('not connected to KiCad');
      return this.rawCall(socket, typeName, payload);
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async getOpenDocuments(): Promise<KicadDocumentInfo[]> {
    const docs: KicadDocumentInfo[] = [];
    for (const doctype of [DOCTYPE_PCB, DOCTYPE_SCHEMATIC]) {
      let res: Record<string, unknown>;
      try {
        res = await this.call('kiapi.common.commands.GetOpenDocuments', { type: doctype });
      } catch (err) {
        // KiCad 9/10 only implements the API in the PCB editor; an unhandled
        // doctype is expected, not a bridge failure (feature detection, 2.4).
        if (doctype === DOCTYPE_PCB) throw err;
        continue;
      }
      const list = (res.documents ?? []) as Array<{
        type?: string;
        boardFilename?: string;
        sheetPath?: { pathHumanReadable?: string };
        project?: { name?: string; path?: string };
      }>;
      for (const d of list) {
        docs.push({
          type: d.type === 'DOCTYPE_PCB' ? 'pcb' : d.type === 'DOCTYPE_SCHEMATIC' ? 'schematic' : 'other',
          name: d.boardFilename ?? d.sheetPath?.pathHumanReadable ?? '(unnamed)',
          projectName: d.project?.name ?? null,
          projectPath: d.project?.path ?? null,
        });
      }
    }
    return docs;
  }

  async getSelection(): Promise<KicadSelectionItem[]> {
    const boards = (await this.getOpenDocuments()).filter((d) => d.type === 'pcb');
    const board = boards[0];
    if (!board) return [];
    const res = await this.call('kiapi.common.commands.GetSelection', {
      header: {
        document: {
          type: 'DOCTYPE_PCB',
          boardFilename: board.name,
          ...(board.projectName || board.projectPath
            ? { project: { name: board.projectName ?? '', path: board.projectPath ?? '' } }
            : {}),
        },
      },
    });
    const root = await loadProtoRoot();
    const items = (res.items ?? []) as AnyObj[];
    return items
      .map((raw) => {
        const unpacked = unpackAny(root, raw);
        if (!unpacked) return null;
        return toSelectionItem(unpacked.typeName, unpacked.message);
      })
      .filter((x): x is KicadSelectionItem => x !== null);
  }

  /**
   * The board file (from a run's touched set) that is open in the connected
   * KiCad, or null. Drives the post-run reload prompt (AC-114.4). Matches on
   * basename: DocumentSpecifier carries the board's filename, not its path.
   */
  async openBoardTouchedBy(files: string[]): Promise<string | null> {
    if (!this.connected) return null;
    const touched = files.filter((f) => f.endsWith('.kicad_pcb'));
    if (!touched.length) return null;
    const open = new Set(
      (await this.getOpenDocuments()).filter((d) => d.type === 'pcb').map((d) => path.basename(d.name)),
    );
    return touched.find((f) => open.has(path.basename(f))) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Selection shaping (shared by the tool result and the turn-start injection)

/** Field → BoardText → Text → the actual string. */
function fieldText(field: unknown): string | null {
  const text = (field as { text?: { text?: { text?: string } } } | undefined)?.text?.text?.text;
  return typeof text === 'string' && text !== '' ? text : null;
}

function toSelectionItem(typeName: string, obj: Record<string, unknown>): KicadSelectionItem {
  const short = typeName.split('.').pop() ?? typeName;
  const kind = short === 'FootprintInstance' ? 'footprint' : short.replace(/^Board/, '').toLowerCase();
  const net = (obj.net as { name?: string } | undefined)?.name ?? null;
  return {
    kind,
    reference: fieldText(obj.referenceField),
    value: fieldText(obj.valueField),
    net: net !== '' ? net : null,
  };
}

/** One compact line per item, e.g. `footprint C3 (100nF) net /VBUS`. */
export function describeSelection(items: KicadSelectionItem[]): string[] {
  return items.map((it) =>
    [it.kind, it.reference, it.value ? `(${it.value})` : null, it.net ? `net ${it.net}` : null]
      .filter(Boolean)
      .join(' '),
  );
}

/**
 * The reload prompt after a committed run (AC-114.4, D5), or null when there
 * is nothing to say. Never triggers a reload: the API exposes neither a
 * reload-from-disk call nor a dirty-state query, so anything forced could
 * discard unsaved in-editor work. Bridge failures are soft (D6): null.
 */
export async function kicadReloadNote(bridge: KicadBridge | null, files: string[]): Promise<string | null> {
  if (!bridge?.isConnected || !files.length) return null;
  try {
    const open = await bridge.openBoardTouchedBy(files);
    if (!open) return null;
    return `${path.basename(open)} is open in KiCad: reload it there (File > Revert) to pick up this change`;
  } catch {
    return null;
  }
}
