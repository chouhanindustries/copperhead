/**
 * Dock-based line prompt with live slash-command suggestions.
 * The input renders inside a bordered box pinned to the bottom of the
 * viewport (Claude Code-style), with an optional status bar underneath.
 * Typing `/` shows matching commands under the box; ↑/↓ + Enter picks one.
 */

import { bright, copper, copperLight, dim, warn } from '../agent/theme.js';
import { rule, statusBar, visibleWidth, wrapSpans, type Span } from '../agent/box.js';
import { TerminalDock } from './dock.js';
import type { SelectItem } from './select.js';

export interface LivePromptOptions {
  /** Plain-text prompt prefix; the box paints it (do not pre-color). */
  prompt: string;
  commands: SelectItem[];
  output?: NodeJS.WriteStream;
  /** Next keypress; null means EOF. */
  readKey: () => Promise<string | null>;
  /**
   * Sync drain of already-queued printable chars (paste coalescing).
   * Without this, a long paste repaints once per character.
   */
  drainPrintable?: () => string;
  /** Shared dock; an internal one is created over `output` when absent. */
  dock?: TerminalDock;
  /** Dim example text shown while the buffer is empty. */
  placeholder?: string;
  /** Status-bar halves, re-read on every repaint (pre-painted strings). */
  status?: () => { left: string; right: string };
  /** Right-aligned meta line just above the input rules (hidden while the menu is open). */
  meta?: () => string;
  /** Sink for the submitted-line echo (defaults to a raw output write). */
  echo?: (line: string) => void;
  /** Session log lines for PgUp/PgDn history scrolling. */
  history?: () => string[];
}

/** Visible width ignoring SGR; kept for existing callers/tests. */
export function visibleLen(s: string): number {
  return visibleWidth(s);
}

/** How many terminal rows `prompt + buffer` occupies at `cols` width. */
export function inputRowRows(prompt: string, buffer: string, cols: number): number {
  const w = Math.max(1, cols || 80);
  return Math.max(1, Math.ceil(visibleLen(prompt + buffer) / w));
}

function matchesFor(buffer: string, commands: SelectItem[]): SelectItem[] {
  if (!buffer.startsWith('/')) return [];
  const p = buffer.toLowerCase();
  if (p === '/') return commands;
  return commands.filter((c) => c.value.startsWith(p));
}

/**
 * Visible slash-menu lines (exported for tests): Claude Code-style rows of
 * `label  description`. The hovered row is recolored (no inverse video) and
 * its description wraps to a second row instead of truncating. Long lists
 * are windowed to `maxVisible` rows around the hovered item.
 */
export function suggestionLines(
  matches: SelectItem[],
  index: number,
  maxVisible = 10,
  width = 100,
): string[] {
  if (!matches.length) return [dim('  (no matching commands)')];
  const clamped = Math.max(0, Math.min(index, matches.length - 1));
  const labelW = Math.max(...matches.map((m) => m.label.length), 8);
  /** `  ❯ ` + label + two-space gap. */
  const prefix = 4 + labelW + 2;
  const descW = Math.max(10, width - prefix);

  let start = 0;
  if (matches.length > maxVisible) {
    start = Math.min(Math.max(0, clamped - (maxVisible >> 1)), matches.length - maxVisible);
  }
  const end = Math.min(matches.length, start + maxVisible);

  const rows: string[] = [];
  for (let i = start; i < end; i++) {
    const item = matches[i]!;
    const hovered = i === clamped;
    const label = item.label.padEnd(labelW);
    const desc = item.description ?? '';
    if (!hovered) {
      rows.push(`    ${label}  ${desc}`);
      continue;
    }
    const first = desc.slice(0, descW);
    const rest = desc.slice(descW);
    rows.push(`  ${copper('❯')} ${copperLight(label)}  ${copperLight(first)}`);
    if (rest) {
      const cont = rest.length > descW ? `${rest.slice(0, descW - 1)}…` : rest;
      rows.push(' '.repeat(prefix) + copperLight(cont));
    }
  }

  return [
    ...(start > 0 ? [dim(`  ↑ ${start} more`)] : []),
    ...rows,
    ...(end < matches.length ? [dim(`  ↓ ${matches.length - end} more`)] : []),
  ];
}

/** Normalize arrow key aliases (CSI + SS3) to a small set. */
export function normalizeNavKey(key: string): string {
  // CSI: \x1b[A  SS3: \x1bOA  (common across terminals / tmux)
  if (key === '\x1b[A' || key === '\x1bOA' || key === '\x1b[1;2A') return 'up';
  if (key === '\x1b[B' || key === '\x1bOB' || key === '\x1b[1;2B') return 'down';
  if (key === '\x1b[C' || key === '\x1bOC') return 'right';
  if (key === '\x1b[D' || key === '\x1bOD') return 'left';
  return key;
}

/** Bracketed-paste mode (DECSET 2004): on while the prompt owns the terminal. */
export const PASTE_ON = '\x1b[?2004h';
export const PASTE_OFF = '\x1b[?2004l';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** Assembler state; `paste` is true between the bracketed-paste markers. */
export interface PendingKeys {
  buf: string;
  paste?: boolean;
}

/**
 * Length of the trailing slice of `s` that could still grow into `marker`,
 * so a marker split across two reads is never mistaken for pasted text.
 */
function partialTail(s: string, marker: string): number {
  for (let n = Math.min(marker.length - 1, s.length); n > 0; n--) {
    if (marker.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}

/**
 * Push bytes through an escape-sequence assembler. Handles arrows that arrive
 * split across reads (`\x1b` then `[A`), and treats a bracketed paste as
 * literal text so a pasted newline cannot submit the line mid-request.
 *
 * A lone `\x1b` is held back, because it is also the first byte of every arrow
 * key; KeyReader flushes it as a real Esc once its disambiguation timer fires.
 */
export function pushKeys(pending: PendingKeys, chunk: string, emit: (key: string) => void): void {
  pending.buf += chunk;
  while (pending.buf.length) {
    const s = pending.buf;

    // Inside a paste: everything up to the end marker is content, never a
    // command. Control characters fold to spaces so a multi-line paste lands
    // in the buffer as one request instead of submitting its first line.
    if (pending.paste) {
      const end = s.indexOf(PASTE_END);
      const body = end === -1 ? s.slice(0, s.length - partialTail(s, PASTE_END)) : s.slice(0, end);
      // Indexed, not for-of: the rest of the assembler emits single code
      // units, and surrogate halves reassemble in the caller's buffer.
      for (let i = 0; i < body.length; i++) emit(body[i]! < ' ' ? ' ' : body[i]!);
      if (end === -1) {
        pending.buf = s.slice(body.length);
        return;
      }
      pending.paste = false;
      pending.buf = s.slice(end + PASTE_END.length);
      continue;
    }

    if (s[0] !== '\x1b') {
      emit(s[0]!);
      pending.buf = s.slice(1);
      continue;
    }
    // Incomplete ESC — wait for more bytes (or for the Esc flush timer).
    if (s.length === 1) return;

    // SS3: ESC O A/B/C/D
    if (s[1] === 'O') {
      if (s.length < 3) return;
      emit(s.slice(0, 3));
      pending.buf = s.slice(3);
      continue;
    }

    // CSI: ESC [ … letter
    if (s[1] === '[') {
      // Need at least ESC [ X
      if (s.length < 3) return;
      // Consume until a final byte (@-~) for longer sequences (e.g. \x1b[1;2A)
      let j = 2;
      while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) < 0x40) j++;
      if (j >= s.length) return; // incomplete
      const seq = s.slice(0, j + 1);
      pending.buf = s.slice(j + 1);
      // Paste markers steer the assembler; they are never keys themselves.
      if (seq === PASTE_START) {
        pending.paste = true;
        continue;
      }
      if (seq === PASTE_END) continue; // stray end marker: nothing to close
      emit(seq);
      continue;
    }

    // Lone ESC (or ESC + non-CSI) — emit Esc
    emit('\x1b');
    pending.buf = s.slice(1);
  }
}

/**
 * Session-long key reader. Keeps the stream alive across many prompts
 * (unlike `for await` of a Readable, which destroys it on exit).
 */
export class KeyReader {
  private readonly queue: string[] = [];
  private readonly waiters: Array<(v: string | null) => void> = [];
  private ended = false;
  private paused = false;
  private readonly wasRaw: boolean | undefined;
  private readonly pending: PendingKeys = { buf: '' };
  private readonly onData: (c: string | Buffer) => void;
  private readonly onEnd: () => void;
  /** Pending "is this a bare Esc or the head of an arrow key?" decision. */
  private escTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * How long a lone `\x1b` waits for the rest of an escape sequence before it
   * is delivered as a real Escape keypress. Every arrow key starts with the
   * same byte, so without this a bare Esc would either be swallowed forever or
   * eat the next arrow. 40ms is the usual terminal-emulator figure: far longer
   * than the microseconds a real sequence takes to arrive, far shorter than a
   * human follow-up keystroke.
   */
  constructor(
    private readonly input: NodeJS.ReadStream,
    private readonly escFlushMs = 40,
  ) {
    this.wasRaw = input.isRaw;
    if (typeof input.setRawMode === 'function') input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    this.onData = (c: string | Buffer): void => {
      // While paused (agent run in flight): forward Ctrl+C as a real SIGINT
      // so the user can interrupt the turn; swallow everything else so typed
      // keys are neither queued nor echoed.
      if (this.paused) {
        if (String(c).includes('\x03')) process.kill(process.pid, 'SIGINT');
        return;
      }
      this.clearEscTimer();
      pushKeys(this.pending, String(c), (key) => this.deliver(key));
      // A trailing lone ESC is ambiguous until either more bytes or the timer
      // arrives; anything else left over is a genuinely partial sequence.
      //
      // Never inside a paste: there the held `\x1b` is the first byte of a
      // split `\x1b[201~` end marker, not a keypress. Flushing it would both
      // deliver a phantom Escape and eat the ESC the marker needs, so paste
      // mode could never close: every later byte would fold to a space
      // (including Enter and Ctrl+C), leaving the session unusable from the
      // keyboard. A real Esc typed inside a paste is content, and folds to a
      // space like any other control byte.
      if (this.pending.buf === '\x1b' && !this.pending.paste) {
        this.escTimer = setTimeout(() => {
          this.escTimer = null;
          if (this.pending.buf !== '\x1b') return;
          this.pending.buf = '';
          this.deliver('\x1b');
        }, this.escFlushMs);
        // Never hold the process open for a keypress that may never come.
        this.escTimer.unref?.();
      }
    };
    this.onEnd = (): void => {
      this.clearEscTimer();
      // Flush a dangling ESC if the stream ends mid-sequence.
      if (this.pending.buf) {
        for (const ch of this.pending.buf) this.deliver(ch);
        this.pending.buf = '';
      }
      this.ended = true;
      while (this.waiters.length) this.waiters.shift()!(null);
    };

    input.on('data', this.onData);
    input.on('end', this.onEnd);
  }

  private deliver(key: string): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(key);
    else this.queue.push(key);
  }

  private clearEscTimer(): void {
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
  }

  async next(): Promise<string | null> {
    if (this.queue.length) return this.queue.shift()!;
    if (this.ended) return null;
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Sync: pull every already-queued printable character (paste batch). */
  drainPrintable(): string {
    let out = '';
    while (this.queue.length) {
      const k = this.queue[0]!;
      if (k.length === 1 && k >= ' ') {
        out += this.queue.shift();
      } else {
        break;
      }
    }
    return out;
  }

  /**
   * Swallow keys while an agent turn owns the terminal. Raw mode stays ON:
   * cooked mode would echo typed keys (PgUp becomes `^[[5~` garbage on the
   * screen); instead Ctrl+C is forwarded as a real SIGINT and everything
   * else is discarded.
   */
  pause(): void {
    this.paused = true;
    this.clearEscTimer();
    this.queue.length = 0;
    this.pending.buf = '';
    this.pending.paste = false;
  }

  /** Resume delivering keys to the prompt. */
  resume(): void {
    this.paused = false;
    if (typeof this.input.setRawMode === 'function') this.input.setRawMode(true);
    this.input.resume();
  }

  close(): void {
    this.clearEscTimer();
    this.input.off('data', this.onData);
    this.input.off('end', this.onEnd);
    this.ended = true;
    this.paused = true;
    while (this.waiters.length) this.waiters.shift()!(null);
    if (typeof this.input.setRawMode === 'function') {
      this.input.setRawMode(this.wasRaw ?? false);
    }
  }
}

/** Tiny key source for unit tests. */
export function keySequence(keys: string[]): () => Promise<string | null> {
  let i = 0;
  return async () => (i < keys.length ? keys[i++]! : null);
}

/**
 * Read one line inside the bottom dock. When the buffer starts with `/`,
 * live suggestions appear under the input box. Returns the submitted line,
 * a selected slash command, or null on Ctrl+C / EOF.
 */
export async function promptWithSlashHints(opts: LivePromptOptions): Promise<string | null> {
  const output = opts.output ?? process.stdout;
  const dock = opts.dock ?? new TerminalDock(output);
  let buffer = '';
  let index = 0;
  /** First Ctrl+C clears the input and arms; a second one exits. */
  let ctrlCArmed = false;
  /** Lines scrolled up into the session history (0 = live view). */
  let scrollOffset = 0;

  const boxWidth = (): number => Math.max(10, dock.cols() - 1);

  const inputAreaLines = (): string[] => {
    const w = boxWidth();
    const spans: Span[] = [{ text: opts.prompt, paint: copper }];
    if (buffer === '' && opts.placeholder) {
      spans.push({ text: opts.placeholder, paint: dim });
    } else {
      spans.push({ text: buffer, paint: bright });
    }
    // Claude Code-style: full-width rules above and below, no side borders.
    return [rule(w), ...wrapSpans(spans, w), rule(w)];
  };

  /** Real-cursor position: dock-relative row (1-based) and column of the caret. */
  const caretPos = (headRows: number): { row: number; col: number } => {
    const w = boxWidth();
    const len = visibleWidth(opts.prompt) + visibleWidth(buffer);
    const bodyRows = Math.max(1, Math.ceil(Math.max(1, len + 1) / w));
    const rowIdx = Math.min(Math.floor(len / w), bodyRows - 1);
    const col = Math.min(len - rowIdx * w + 1, w);
    return { row: headRows + 1 + rowIdx + 1, col };
  };

  const renderDock = (): void => {
    const w = boxWidth();
    const inputLines = inputAreaLines();
    const statusLine = ctrlCArmed
      ? statusBar(`  ${warn('press ctrl+c again to exit')}`, '', w)
      : scrollOffset > 0
        ? statusBar(`  ${warn(`history ↑${scrollOffset} · pgup/pgdn scroll · any key returns`)}`, '', w)
        : opts.status
          ? (() => {
              const { left, right } = opts.status!();
              return statusBar(`  ${left}`, `${right} `, w);
            })()
          : null;

    // Idle dock is small (meta + rules + input + status) so the content
    // region above stays large. The menu overlays upward on open: the dock
    // grows into the rows above without scrolling (Claude Code behavior) and
    // clears them again on close.
    const winRows =
      typeof (output as NodeJS.WriteStream).rows === 'number' && (output as NodeJS.WriteStream).rows
        ? (output as NodeJS.WriteStream).rows!
        : 24;
    const maxItems = Math.max(3, Math.min(10, winRows - inputLines.length - (statusLine ? 1 : 0) - 12));

    let head: string[];
    if (buffer.startsWith('/')) {
      const matches = matchesFor(buffer, opts.commands);
      if (index >= matches.length) index = Math.max(0, matches.length - 1);
      head = suggestionLines(matches, index, maxItems, w);
    } else {
      head = opts.meta ? [statusBar('', `${opts.meta()} `, w)] : [];
    }

    dock.set(
      [...head, ...inputLines, ...(statusLine !== null ? [statusLine] : [])],
      caretPos(head.length),
    );
  };

  const finish = (value: string | null): string | null => {
    if (value === null) {
      // Session is ending (quit / EOF / double Ctrl+C): drop the dock.
      dock.release();
      output.write('\n');
      return value;
    }
    // Keep the dock (and its scroll fence) through the turn so output stays
    // in the content region and the banner is never scrolled away; show a
    // passive input row until the next prompt.
    const w = boxWidth();
    dock.set([
      ...(opts.meta ? [statusBar('', `${opts.meta()} `, w)] : []),
      rule(w),
      dim('  … working — ctrl+c interrupts'),
      rule(w),
      ...(opts.status ? [(() => {
        const { left, right } = opts.status!();
        return statusBar(`  ${left}`, `${right} `, w);
      })()] : []),
    ]);
    // Commit the submitted line into the content region so history shows
    // what actually ran (e.g. `/demo` picked from the bare-`/` dropdown).
    if (opts.echo) opts.echo(opts.prompt + value);
    else output.write(opts.prompt + value + '\n');
    return value;
  };

  /** Repaint the content region at the current history offset. */
  const paintHistory = (): void => {
    const hist = opts.history?.() ?? [];
    const end = Math.max(0, hist.length - scrollOffset);
    dock.paintContent(hist.slice(Math.max(0, end - dock.contentRows()), end));
  };

  renderDock();

  for (;;) {
    const raw = await opts.readKey();
    if (raw === null) return finish(null);
    const key = normalizeNavKey(raw);

    // PgUp/PgDn scroll the session history in the content region; any other
    // key snaps back to the live tail.
    if ((key === '\x1b[5~' || key === '\x1b[6~') && opts.history) {
      const hist = opts.history();
      const page = Math.max(1, dock.contentRows() - 2);
      const maxOff = Math.max(0, hist.length - dock.contentRows());
      scrollOffset =
        key === '\x1b[5~'
          ? Math.min(maxOff, scrollOffset + page)
          : Math.max(0, scrollOffset - page);
      paintHistory();
      renderDock();
      continue;
    }
    if (scrollOffset > 0 && key !== 'up' && key !== 'down') {
      scrollOffset = 0;
      paintHistory();
      renderDock();
    }

    if (key === '\x03') {
      if (ctrlCArmed) return finish(null);
      ctrlCArmed = true;
      buffer = '';
      index = 0;
      renderDock();
      continue;
    }
    if (ctrlCArmed) {
      ctrlCArmed = false;
      renderDock();
    }
    if (key === '\x04' && buffer === '') return finish(null);

    if (key === '\r' || key === '\n') {
      const matches = matchesFor(buffer, opts.commands);
      if (buffer.startsWith('/') && matches.length > 0) {
        return finish(matches[index]!.value);
      }
      return finish(buffer);
    }

    if (key === '\x1b') {
      if (buffer.startsWith('/')) {
        buffer = '';
        index = 0;
        renderDock();
      }
      continue;
    }

    // Arrows move the hover highlight; j/k only alias them on a bare "/"
    // so they stay typeable inside a longer command (e.g. "/check" needs no
    // j/k, but a future command might).
    const navUp = key === 'up' || key === 'left' || (buffer === '/' && raw === 'k');
    const navDown = key === 'down' || key === 'right' || (buffer === '/' && raw === 'j');
    if (navUp || navDown) {
      const matches = matchesFor(buffer, opts.commands);
      if (matches.length) {
        index = navUp
          ? (index - 1 + matches.length) % matches.length
          : (index + 1) % matches.length;
        renderDock();
      } else if (buffer === '' && opts.history) {
        // Mouse wheels send arrow keys in the alternate screen: line-scroll
        // the session history at an empty prompt.
        const hist = opts.history();
        const maxOff = Math.max(0, hist.length - dock.contentRows());
        scrollOffset = navUp ? Math.min(maxOff, scrollOffset + 2) : Math.max(0, scrollOffset - 2);
        paintHistory();
        renderDock();
      }
      continue;
    }

    if (key === '\t') {
      const matches = matchesFor(buffer, opts.commands);
      if (matches.length >= 1) {
        buffer = matches[index]!.value;
        renderDock();
      }
      continue;
    }

    if (key === '\x7f' || key === '\b') {
      if (buffer.length) {
        buffer = buffer.slice(0, -1);
        index = 0;
        renderDock();
      }
      continue;
    }

    if (key === '\x15') {
      buffer = '';
      index = 0;
      renderDock();
      continue;
    }

    // Printable input; coalesce paste so we paint once per burst instead of
    // once per character.
    if (key.length === 1 && key >= ' ') {
      buffer += key;
      if (opts.drainPrintable) buffer += opts.drainPrintable();
      index = 0;
      renderDock();
    }
  }
}
