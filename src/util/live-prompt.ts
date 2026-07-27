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
  /**
   * Called once with the prompt's render function, so external state changes
   * (e.g. the KiCad bridge connecting while idle) can refresh the meta row.
   * The registration is only valid until this prompt resolves.
   */
  refresh?: (render: () => void) => void;
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

/**
 * Push bytes through an escape-sequence assembler. Handles arrows that arrive
 * split across reads (`\x1b` then `[A`) — otherwise a lone ESC clears the menu.
 */
export function pushKeys(pending: { buf: string }, chunk: string, emit: (key: string) => void): void {
  pending.buf += chunk;
  while (pending.buf.length) {
    const s = pending.buf;
    if (s[0] !== '\x1b') {
      emit(s[0]!);
      pending.buf = s.slice(1);
      continue;
    }
    // Incomplete ESC — wait for more bytes.
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
      emit(s.slice(0, j + 1));
      pending.buf = s.slice(j + 1);
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
  private readonly pending = { buf: '' };
  private readonly onData: (c: string | Buffer) => void;
  private readonly onEnd: () => void;

  constructor(private readonly input: NodeJS.ReadStream) {
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
      pushKeys(this.pending, String(c), (key) => {
        const waiter = this.waiters.shift();
        if (waiter) waiter(key);
        else this.queue.push(key);
      });
    };
    this.onEnd = (): void => {
      // Flush a dangling ESC if the stream ends mid-sequence.
      if (this.pending.buf) {
        for (const ch of this.pending.buf) {
          const waiter = this.waiters.shift();
          if (waiter) waiter(ch);
          else this.queue.push(ch);
        }
        this.pending.buf = '';
      }
      this.ended = true;
      while (this.waiters.length) this.waiters.shift()!(null);
    };

    input.on('data', this.onData);
    input.on('end', this.onEnd);
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
    this.queue.length = 0;
    this.pending.buf = '';
  }

  /** Resume delivering keys to the prompt. */
  resume(): void {
    this.paused = false;
    if (typeof this.input.setRawMode === 'function') this.input.setRawMode(true);
    this.input.resume();
  }

  close(): void {
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
  opts.refresh?.(renderDock);

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
