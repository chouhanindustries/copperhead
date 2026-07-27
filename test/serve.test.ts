/**
 * copperhead serve: NDJSON protocol behavior, offline (AC-114B.1 through
 * AC-114B.4, AC-114B.8). No KiCad, no LLM: injected runner seam, injected
 * check, bridge disabled.
 */

import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { runServe, SERVE_PROTOCOL_VERSION, type ServeOptions } from '../src/commands/serve.js';

interface WireObj {
  id?: string;
  event?: string;
  data?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

function session(extra: Partial<ServeOptions> = {}): {
  send: (obj: Record<string, unknown> | string) => void;
  end: () => void;
  wire: () => WireObj[];
  done: Promise<void>;
} {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  let buf = '';
  output.on('data', (c: Buffer) => {
    buf += c.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  });
  const done = runServe({
    repoRoot: '/tmp/repo',
    model: 'gpt-5',
    modelSource: 'flag',
    version: '0.7.0',
    kicadCliVersion: '9.0.0',
    input,
    output,
    kicad: null,
    runRequest: async (request, log) => {
      log(`working on: ${request}`);
      return { outcome: 'success', summary: `did: ${request}`, filesTouched: ['hardware/x.kicad_sch'] };
    },
    runCheckCmd: async (log) => {
      log('checking');
      return { ok: true };
    },
    ...extra,
  });
  return {
    send: (obj) => input.write((typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n'),
    end: () => input.end(),
    wire: () => lines.map((l) => JSON.parse(l) as WireObj),
    done,
  };
}

describe('handshake and protocol hygiene (AC-114B.1)', () => {
  it('emits exactly one hello with protocol, versions, repo, and model, then waits', async () => {
    const s = session();
    await sleep(30);
    const wire = s.wire();
    expect(wire).toHaveLength(1);
    expect(wire[0]!.event).toBe('hello');
    expect(wire[0]!.data).toMatchObject({
      protocol: SERVE_PROTOCOL_VERSION,
      copperhead: '0.7.0',
      repoRoot: '/tmp/repo',
      model: 'gpt-5',
    });
    s.end();
    await s.done;
  });

  it('answers malformed JSON and unknown methods with error objects and keeps serving', async () => {
    const s = session();
    s.send('this is not json');
    s.send({ id: '1', method: 'frobnicate' });
    s.send({ method: 'run', params: { request: 'no id' } });
    s.send({ id: '2', method: 'run', params: { request: 'still works' } });
    await sleep(50);
    s.end();
    await s.done;
    const wire = s.wire();
    expect(wire.find((o) => o.error?.code === 'bad-json')).toBeTruthy();
    expect(wire.find((o) => o.id === '1' && o.error?.code === 'unknown-method')).toBeTruthy();
    expect(wire.find((o) => o.error?.code === 'bad-request')).toBeTruthy();
    expect(wire.find((o) => o.id === '2' && o.result?.outcome === 'success')).toBeTruthy();
  });

  it('exits on stdin EOF', async () => {
    const s = session();
    s.end();
    await expect(s.done).resolves.toBeUndefined();
  });
});

describe('model-less startup (AC-114B.1)', () => {
  it('still handshakes and checks; runs fail with a no-model error instead of exiting', async () => {
    const s = session({
      model: null,
      modelSource: null,
      modelError: 'no model configured: pass --model, set COPPERHEAD_MODEL, or export an API key',
    });
    s.send({ id: 'r', method: 'run', params: { request: 'add an LED' } });
    s.send({ id: 'c', method: 'check' });
    await sleep(40);
    s.end();
    await s.done; // process-level: EOF still resolves, no startup crash
    const wire = s.wire();
    expect(wire[0]!.event).toBe('hello');
    expect(wire[0]!.data!.model).toBeNull();
    expect(wire.find((o) => o.id === 'r')!.error).toMatchObject({ code: 'no-model' });
    expect(String(wire.find((o) => o.id === 'r')!.error!.message)).toContain('COPPERHEAD_MODEL');
    expect(wire.find((o) => o.id === 'c' && o.result)?.result).toEqual({ ok: true });
  });
});

describe('streamed runs (AC-114B.2)', () => {
  it('streams log events then exactly one result with outcome, summary, files', async () => {
    const s = session();
    s.send({ id: 'r1', method: 'run', params: { request: 'add an LED' } });
    await sleep(50);
    s.end();
    await s.done;
    const wire = s.wire();
    const logs = wire.filter((o) => o.id === 'r1' && o.event === 'log');
    const results = wire.filter((o) => o.id === 'r1' && o.result);
    expect(logs.map((l) => l.data?.line)).toContain('working on: add an LED');
    expect(results).toHaveLength(1);
    expect(results[0]!.result).toEqual({
      outcome: 'success',
      summary: 'did: add an LED',
      filesTouched: ['hardware/x.kicad_sch'],
    });
    // log events precede the result on the wire
    expect(wire.indexOf(logs[0]!)).toBeLessThan(wire.indexOf(results[0]!));
  });

  it('a thrown run becomes a failure result and serve keeps serving', async () => {
    let first = true;
    const s = session({
      runRequest: async (request, log) => {
        if (first) {
          first = false;
          throw new Error('provider exploded');
        }
        log('second run ok');
        return { outcome: 'success', summary: 'ok', filesTouched: [] };
      },
    });
    s.send({ id: 'a', method: 'run', params: { request: 'boom' } });
    await sleep(30);
    s.send({ id: 'b', method: 'run', params: { request: 'again' } });
    await sleep(30);
    s.end();
    await s.done;
    const wire = s.wire();
    expect(wire.find((o) => o.id === 'a')!.result).toMatchObject({ outcome: 'failure', summary: 'provider exploded' });
    expect(wire.find((o) => o.id === 'b' && o.result?.outcome === 'success')).toBeTruthy();
  });

  it('check streams and resolves with ok', async () => {
    const s = session();
    s.send({ id: 'c1', method: 'check' });
    await sleep(30);
    s.end();
    await s.done;
    const wire = s.wire();
    expect(wire.find((o) => o.id === 'c1' && o.event === 'log')?.data?.line).toBe('checking');
    expect(wire.find((o) => o.id === 'c1' && o.result)?.result).toEqual({ ok: true });
  });
});

describe('single flight (AC-114B.3)', () => {
  it('rejects a second run with busy while the first is active, without disturbing it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = session({
      runRequest: async (request, log) => {
        log(`start ${request}`);
        await gate;
        return { outcome: 'success', summary: `finished ${request}`, filesTouched: [] };
      },
    });
    s.send({ id: 'slow', method: 'run', params: { request: 'first' } });
    await sleep(20);
    s.send({ id: 'eager', method: 'run', params: { request: 'second' } });
    await sleep(20);
    const midWire = s.wire();
    expect(midWire.find((o) => o.id === 'eager')!.error).toMatchObject({ code: 'busy' });
    release();
    await sleep(20);
    s.end();
    await s.done;
    expect(s.wire().find((o) => o.id === 'slow' && o.result)?.result).toMatchObject({
      outcome: 'success',
      summary: 'finished first',
    });
  });
});

describe('wire redaction (AC-114B.4)', () => {
  it('redacts secret patterns in log events and results', async () => {
    const s = session({
      runRequest: async (_request, log) => {
        log('using key sk-SUPERSECRET123 for provider');
        return { outcome: 'success', summary: 'token ghp_' + 'a'.repeat(40) + ' seen', filesTouched: [] };
      },
    });
    s.send({ id: 'r', method: 'run', params: { request: 'leaky' } });
    await sleep(30);
    s.end();
    await s.done;
    const raw = JSON.stringify(s.wire());
    expect(raw).not.toContain('sk-SUPERSECRET123');
    expect(raw).not.toContain('ghp_' + 'a'.repeat(40));
    expect(raw).toContain('[REDACTED]');
  });
});
