/**
 * Live progress rendering for agent-loop runs (design D7). Two modes chosen
 * once at startup: interactive (TTY, no --json/--plain) pins a status line to
 * the bottom of the terminal and redraws it in place; plain emits line-oriented
 * output with zero ANSI escapes — the mode CI, pipes, and tests see.
 */

export interface ProgressRenderer {
  log(line: string): void;
  /** Called at the start of each turn with cumulative token totals so far. */
  turnStart(turn: number, maxTurns: number, tokensIn: number, tokensOut: number): void;
  toolResult(name: string, firstLine: string): void;
  /** Busy text while a provider call is in flight; null when idle. */
  status(text: string | null): void;
  /** Final outcome line; replaces the status line in interactive mode. */
  finish(line: string): void;
}

/** Compact token count: 850 -> "850", 12300 -> "12.3k". */
export function fmtTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

/** Compact duration: 42s, 1m32s, 1h04m. */
export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export function turnMarker(turn: number, maxTurns: number, tokensIn: number, tokensOut: number): string {
  return `[turn ${turn}/${maxTurns} · ${fmtTokens(tokensIn)} in / ${fmtTokens(tokensOut)} out]`;
}

/** Wrap a bare log function into the plain (non-interactive) renderer. */
export function plainRenderer(log: (line: string) => void): ProgressRenderer {
  return {
    log,
    turnStart: (turn, maxTurns, tokensIn, tokensOut) => log(turnMarker(turn, maxTurns, tokensIn, tokensOut)),
    toolResult: (name, firstLine) => log(`  [${name}] ${firstLine}`),
    status: () => {},
    finish: (line) => log(line),
  };
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_LINE = '\r\x1b[2K';

/** Minimal writable surface so tests can drive a fake TTY. */
export interface TtyLike {
  write(chunk: string): unknown;
  columns?: number;
}

/**
 * The interactive renderer. Everything printed goes above the status line
 * (clear -> print -> redraw) so the scrollback stays a complete log; only the
 * status line itself is ever redrawn in place (AC-8.8).
 */
export class InteractiveRenderer implements ProgressRenderer {
  private readonly out: TtyLike;
  private startMs = Date.now();
  private turn = 0;
  private maxTurns = 0;
  private tokensIn = 0;
  private tokensOut = 0;
  private busy: string | null = null;
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private statusShown = false;
  /**
   * True between runs: no status line is owned and log lines pass straight
   * through. finish() suspends rather than destroys, because a multi-stage
   * `create` pipeline reuses one renderer across its stages; the next
   * turnStart() re-arms it.
   */
  private idle = true;
  private readonly cleanup = (): void => this.teardown();
  private readonly onSigint = (): void => {
    this.teardown();
    process.exit(130);
  };

  constructor(out: TtyLike = process.stdout) {
    this.out = out;
    process.on('exit', this.cleanup);
    process.on('SIGINT', this.onSigint);
  }

  private statusText(): string {
    const parts = [
      `turn ${this.turn}/${this.maxTurns}`,
      `${fmtTokens(this.tokensIn)} in / ${fmtTokens(this.tokensOut)} out`,
      fmtDuration(Date.now() - this.startMs),
    ];
    if (this.busy) parts.push(this.busy);
    const spinner = this.busy ? FRAMES[this.frame % FRAMES.length] : '·';
    const line = `${spinner} ${parts.join(' · ')}`;
    const width = this.out.columns ?? 80;
    return line.length > width ? line.slice(0, width - 1) : line;
  }

  private redraw(): void {
    if (this.idle) return;
    if (!this.statusShown) {
      this.out.write(HIDE_CURSOR);
      this.statusShown = true;
    }
    this.out.write(CLEAR_LINE + this.statusText());
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.frame++;
      this.redraw();
    }, 80);
    this.timer.unref?.();
  }

  /** Print above the status line: clear it, write, redraw it. */
  log(line: string): void {
    if (this.statusShown) this.out.write(CLEAR_LINE);
    this.out.write(line + '\n');
    this.redraw();
  }

  turnStart(turn: number, maxTurns: number, tokensIn: number, tokensOut: number): void {
    if (this.idle) {
      this.idle = false;
      this.startMs = Date.now(); // elapsed time is per run, not per renderer
    }
    this.turn = turn;
    this.maxTurns = maxTurns;
    this.tokensIn = tokensIn;
    this.tokensOut = tokensOut;
    this.ensureTimer();
    this.redraw();
  }

  toolResult(name: string, firstLine: string): void {
    this.log(`  [${name}] ${firstLine}`);
  }

  status(text: string | null): void {
    this.busy = text;
    if (text && !this.idle) this.ensureTimer();
    this.redraw();
  }

  finish(line: string): void {
    if (this.statusShown) this.out.write(CLEAR_LINE);
    this.out.write(line + '\n');
    this.suspend();
  }

  /** Release the status line (stop the spinner, restore the cursor) but stay usable. */
  private suspend(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.statusShown) {
      this.out.write(CLEAR_LINE + SHOW_CURSOR);
      this.statusShown = false;
    }
    this.busy = null;
    this.frame = 0;
    this.idle = true;
  }

  /** Process is going away (exit/SIGINT): suspend and drop the listeners. */
  private teardown(): void {
    this.suspend();
    process.removeListener('exit', this.cleanup);
    process.removeListener('SIGINT', this.onSigint);
  }
}

/**
 * Pick the renderer for a CLI invocation: interactive only on a real TTY with
 * neither --json nor --plain (AC-8.8/8.9); plain mode is the safe fallback.
 * Under --json, progress goes to stderr so stdout stays machine-parseable
 * (AC-2.4): the only thing a --json invocation writes to stdout is its JSON.
 */
export function makeRenderer(opts: { json: boolean; plain: boolean }): ProgressRenderer {
  if (opts.json) return plainRenderer((line) => console.error(line));
  if (!opts.plain && process.stdout.isTTY) return new InteractiveRenderer();
  return plainRenderer((line) => console.log(line));
}
