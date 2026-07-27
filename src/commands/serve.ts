/**
 * Headless run surface (AC-114B): NDJSON over stdio, one JSON object per
 * line in both directions. Built for the KiCad side panel (issue #114 Phase
 * B) but embedder-agnostic: anything that can spawn a child process and
 * read lines can drive copperhead through it.
 *
 * Protocol (D1, protocol version 1):
 *   -> {"id":"1","method":"run","params":{"request":"..."}}
 *   <- {"id":"1","event":"log","data":{"line":"..."}}      (streamed)
 *   <- {"id":"1","result":{"outcome":"success", ...}}      (exactly one)
 *   <- {"id":"1","error":{"code":"busy","message":"..."}}  (instead of result)
 * Methods: run, check. The hello object is emitted unprompted at startup.
 * There is no cancel method: the agent loop cannot abort mid-turn, so run
 * interruption is the embedder killing this process (REPL Ctrl+C semantics).
 *
 * Serve is an attended surface like the REPL and `do` (D2): it constructs
 * the KiCad IPC bridge, so panel-launched runs get selection context and the
 * reload prompt. check/sync/create isolation (AC-114.6) is untouched.
 */

import { createInterface } from 'node:readline';
import { runAgentLoop, type RunResult } from '../agent/loop.js';
import { plainRenderer } from '../agent/render.js';
import { redactSecrets } from '../util/redact.js';
import { KicadBridge } from '../kicad/ipc.js';
import type { ModelSource } from '../config.js';
import { runCheck } from './check.js';

export const SERVE_PROTOCOL_VERSION = 1;

export interface ServeOptions {
  repoRoot: string;
  model: string;
  modelSource: ModelSource;
  version: string;
  kicadCliVersion: string;
  maxTurns?: number;
  /** Override streams (tests). Defaults to stdin/stdout. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** Injected runner (tests). Defaults to the gated agent loop. */
  runRequest?: (
    request: string,
    log: (line: string) => void,
  ) => Promise<Pick<RunResult, 'outcome' | 'summary' | 'filesTouched'>>;
  /** Injected /check (tests). */
  runCheckCmd?: (log: (line: string) => void) => Promise<{ ok: boolean }>;
  /** KiCad bridge injection: undefined creates one, null disables (tests). */
  kicad?: KicadBridge | null;
}

interface Request {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/** Run the serve loop; resolves when stdin reaches EOF. */
export async function runServe(opts: ServeOptions): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;

  // Redaction on the wire (AC-114B.4): applied to the serialized line, the
  // same choke point the transcript uses, so no emit path can forget it.
  const emit = (obj: Record<string, unknown>): void => {
    output.write(redactSecrets(JSON.stringify(obj)) + '\n');
  };

  const ownBridge = opts.kicad === undefined;
  const bridge: KicadBridge | null = ownBridge ? new KicadBridge() : (opts.kicad ?? null);
  bridge?.start();

  const runOne =
    opts.runRequest ??
    (async (request: string, log: (line: string) => void) => {
      const res = await runAgentLoop({
        repoRoot: opts.repoRoot,
        request,
        model: opts.model,
        ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
        allowDirty: true,
        interactive: false,
        kicad: bridge,
        renderer: plainRenderer(log),
        log,
        meta: {
          command: 'serve',
          modelSource: opts.modelSource,
          version: opts.version,
          kicadCliVersion: opts.kicadCliVersion,
        },
      });
      return { outcome: res.outcome, summary: res.summary, filesTouched: res.filesTouched };
    });
  const checkOne =
    opts.runCheckCmd ?? (async (log: (line: string) => void) => runCheck(opts.repoRoot, log));

  emit({
    event: 'hello',
    data: {
      protocol: SERVE_PROTOCOL_VERSION,
      copperhead: opts.version,
      kicadCli: opts.kicadCliVersion,
      repoRoot: opts.repoRoot,
      model: opts.model,
      modelSource: opts.modelSource,
    },
  });

  /** Single flight (AC-114B.3): id of the active run, or null. */
  let active: string | null = null;
  /** Keeps the loop from resolving EOF while a run still streams. */
  let inFlight: Promise<void> = Promise.resolve();

  const handle = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: Request;
    try {
      req = JSON.parse(trimmed) as Request;
    } catch {
      emit({ error: { code: 'bad-json', message: `not valid JSON: ${trimmed.slice(0, 80)}` } });
      return;
    }
    const id = typeof req.id === 'string' || typeof req.id === 'number' ? String(req.id) : null;
    const method = typeof req.method === 'string' ? req.method : '';
    if (id === null) {
      emit({ error: { code: 'bad-request', message: 'missing id' } });
      return;
    }

    switch (method) {
      case 'run': {
        const request = (req.params as { request?: unknown } | undefined)?.request;
        if (typeof request !== 'string' || request.trim() === '') {
          emit({ id, error: { code: 'bad-request', message: 'params.request must be a non-empty string' } });
          return;
        }
        if (active !== null) {
          emit({ id, error: { code: 'busy', message: `a run is already active (id ${active})` } });
          return;
        }
        active = id;
        const log = (l: string): void => {
          for (const one of String(l).split('\n')) emit({ id, event: 'log', data: { line: one } });
        };
        inFlight = (async () => {
          try {
            const res = await runOne(request, log);
            emit({ id, result: { outcome: res.outcome, summary: res.summary, filesTouched: res.filesTouched } });
          } catch (err) {
            // A thrown run (as opposed to a failed one) is still a result-shaped
            // ending: the embedder needs its input re-enabled either way.
            emit({ id, result: { outcome: 'failure', summary: (err as Error).message, filesTouched: [] } });
          } finally {
            active = null;
          }
        })();
        return;
      }
      case 'check': {
        if (active !== null) {
          emit({ id, error: { code: 'busy', message: `a run is already active (id ${active})` } });
          return;
        }
        active = id;
        const log = (l: string): void => {
          for (const one of String(l).split('\n')) emit({ id, event: 'log', data: { line: one } });
        };
        inFlight = (async () => {
          try {
            const res = await checkOne(log);
            emit({ id, result: { ok: res.ok } });
          } catch (err) {
            emit({ id, error: { code: 'check-failed', message: (err as Error).message } });
          } finally {
            active = null;
          }
        })();
        return;
      }
      default:
        emit({ id, error: { code: 'unknown-method', message: `unknown method "${method}"` } });
    }
  };

  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) handle(line);
  // EOF: the consumer is gone (D-risk: no orphans). Let an in-flight run
  // finish streaming into the void rather than tearing state mid-write.
  await inFlight;
  if (ownBridge) bridge?.stop();
}
