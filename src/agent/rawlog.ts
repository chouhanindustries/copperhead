import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets } from '../util/redact.js';

/**
 * The two verbatim records a run keeps beside its structured transcript
 * (`transcript.jsonl`), both written live:
 *
 * - `raw.log` — exactly what went to and came back from the model: request
 *   payloads, response payloads, and for the CLI-backed providers their own
 *   stdout/stderr. The transcript records what the loop *understood*; this
 *   records what it was actually told, which is the difference between
 *   debugging a copperhead bug and debugging a provider one.
 * - `console.log` — every line the run printed, without ANSI. `do` and
 *   `create` otherwise leave nothing behind but the terminal scrollback.
 *
 * Both redact at write time (AC-4.1), both are append-only, and both cap
 * themselves so a pathological run cannot fill the disk.
 */

/** Per-entry payload cap; a longer payload is truncated with a marker. */
const MAX_ENTRY_BYTES = 256 * 1024;
/** Whole-file cap. Past it the log stops growing and says so, once. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

const SGR_RE = /\x1b\[[0-9;]*m/g;

/**
 * Append-only line writer: serialized through a promise chain so concurrent
 * callers cannot interleave a half-written line, and never throws — losing a
 * log line is acceptable, failing a run to report one is not.
 */
class LineFile {
  private queue: Promise<void> = Promise.resolve();
  private written = 0;
  private capped = false;

  constructor(private readonly file: string) {}

  /** Queue a line. Fire-and-forget by design; await `flush()` to settle. */
  append(line: string): void {
    if (this.capped) return;
    const payload = line.length > MAX_ENTRY_BYTES ? `${line.slice(0, MAX_ENTRY_BYTES)}…[truncated]` : line;
    this.written += payload.length + 1;
    const atCap = this.written >= MAX_FILE_BYTES;
    if (atCap) this.capped = true;
    const text = atCap ? `${payload}\n[log capped at ${MAX_FILE_BYTES} bytes; further entries dropped]\n` : `${payload}\n`;
    this.queue = this.queue
      .then(async () => {
        // The rollback path has deleted a run directory mid-run before; recreate
        // rather than lose the rest of the log.
        await mkdir(path.dirname(this.file), { recursive: true });
        await appendFile(this.file, redactSecrets(text), 'utf8');
      })
      .catch(() => {});
  }

  /** Settle every queued write. Used before a run reports its artifacts. */
  async flush(): Promise<void> {
    await this.queue;
  }
}

/** One entry in `raw.log`. */
export interface RawEntry {
  /** What this is: `request`, `response`, `stream-error`, `stdout`, `stderr`, … */
  kind: string;
  /** Which provider produced it, for runs that fail over mid-flight. */
  provider?: string;
  data: unknown;
}

/** What a provider is handed to record its own traffic. */
export type RawSink = (entry: RawEntry) => void;

/** `raw.log`: verbatim provider traffic, one JSON object per line. */
export class RawLog {
  private readonly file: LineFile;
  readonly path: string;

  constructor(runDir: string) {
    this.path = path.join(runDir, 'raw.log');
    this.file = new LineFile(this.path);
  }

  /** Bind a sink for one provider so every entry is attributed without ceremony. */
  sink(provider: string): RawSink {
    return (entry) => this.write({ ...entry, provider: entry.provider ?? provider });
  }

  write(entry: RawEntry): void {
    // Stringify defensively: a payload with a cycle (or a BigInt) must not be
    // the thing that takes down a run.
    let data: string;
    try {
      data = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    } catch {
      data = JSON.stringify({ ts: new Date().toISOString(), kind: entry.kind, provider: entry.provider, data: '[unserializable]' });
    }
    this.file.append(data);
  }

  flush(): Promise<void> {
    return this.file.flush();
  }
}

/** `console.log`: a plain-text mirror of everything the run printed. */
export class ConsoleMirror {
  private readonly file: LineFile;
  readonly path: string;

  constructor(runDir: string) {
    this.path = path.join(runDir, 'console.log');
    this.file = new LineFile(this.path);
  }

  /** Strip ANSI so the mirror stays readable in a pager or a bug report. */
  write(line: string): void {
    this.file.append(line.replace(SGR_RE, ''));
  }

  flush(): Promise<void> {
    return this.file.flush();
  }
}
