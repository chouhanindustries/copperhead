import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TerminalDock } from '../src/util/dock.js';
import {
  callout,
  inverse,
  rule,
  statusBar,
  truncateVisible,
  visibleWidth,
  wrapSpans,
} from '../src/agent/box.js';
import { keySequence, promptWithSlashHints, suggestionLines } from '../src/util/live-prompt.js';
import { SLASH_COMMANDS } from '../src/commands/repl.js';
import { animateMarkAt, fiducialBootFrames } from '../src/agent/animate.js';
import { DockRenderer } from '../src/agent/dock-renderer.js';
import { fiducialMark } from '../src/agent/logo.js';
import {
  bold,
  bright,
  copper,
  copperLight,
  ruleDim,
  setColorEnabled,
} from '../src/agent/theme.js';

function fakeOut(columns = 40): NodeJS.WriteStream & { written: string } {
  const state = { written: '', columns, rows: 24 };
  return {
    get written() {
      return state.written;
    },
    columns: state.columns,
    rows: state.rows,
    write(c: string) {
      state.written += c;
      return true;
    },
  } as unknown as NodeJS.WriteStream & { written: string };
}

beforeEach(() => setColorEnabled(false));

describe('box primitives', () => {
  it('wrapSpans slices across span boundaries at the wrap width', () => {
    expect(wrapSpans([{ text: 'abc' }, { text: 'defg' }], 5)).toEqual(['abcde', 'fg']);
    expect(wrapSpans([{ text: '' }], 5)).toEqual(['']);
  });

  it('wrapSpans applies styling per slice so SGR never spans a wrap', () => {
    setColorEnabled(true);
    try {
      const lines = wrapSpans([{ text: 'abcdef', paint: (s) => `<${s}>` }], 3);
      expect(lines).toEqual(['<abc>', '<def>']);
    } finally {
      setColorEnabled(false);
    }
  });

  it('rule spans the requested visible width', () => {
    expect(visibleWidth(rule(20))).toBe(20);
    expect(rule(20)).toContain('─');
  });

  it('statusBar right-justifies within the width and degrades when narrow', () => {
    const line = statusBar('left', 'R', 20);
    expect(visibleWidth(line)).toBe(20);
    expect(line.endsWith('R')).toBe(true);
    // Too narrow for both: keep the left side but never exceed the width.
    expect(statusBar('a very long left side', 'right', 10)).toBe('a very lon');
  });

  it('callout carries the bar, title, and body', () => {
    const lines = callout('info', 'New repository?', ['run copperhead init']);
    expect(lines[0]).toContain('▎');
    expect(lines[0]).toContain('New repository?');
    expect(lines[1]).toContain('run copperhead init');
  });

  it('inverse is a no-op when color is off and wraps when on', () => {
    expect(inverse('x')).toBe('x');
    setColorEnabled(true);
    try {
      expect(inverse('x')).toBe('\x1b[7mx\x1b[0m');
    } finally {
      setColorEnabled(false);
    }
  });
});

describe('TerminalDock (scroll-region fence)', () => {
  it('fences content with DECSTBM and paints the dock with absolute addressing', () => {
    const out = fakeOut(40); // rows: 24
    const dock = new TerminalDock(out);
    dock.set(['DOCK-A', 'DOCK-B']);
    // Content fenced to rows 1..22; dock painted at rows 23 and 24.
    expect(out.written).toContain('\x1b[1;22r');
    expect(out.written).toContain('\x1b[23;1H');
    expect(out.written).toContain('\x1b[24;1H');
    expect(out.written).toContain('DOCK-A');
    expect(out.written).toContain('DOCK-B');
  });

  it('same-height repaints never touch the scroll region', () => {
    const out = fakeOut(40);
    const dock = new TerminalDock(out);
    dock.set(['A']);
    const before = (out.written.match(/\x1b\[1;23r/g) ?? []).length;
    dock.set(['B']);
    dock.set(['C']);
    const after = (out.written.match(/\x1b\[1;23r/g) ?? []).length;
    expect(before).toBe(1);
    expect(after).toBe(1); // fence set once, repaints are pure absolute writes
  });

  it('log is a plain write: the fence keeps the dock safe without repaints', () => {
    const out = fakeOut(40);
    const dock = new TerminalDock(out);
    dock.set(['DOCK-ROW']);
    const lenBefore = out.written.length;
    dock.log('hello');
    expect(out.written.slice(lenBefore)).toBe('hello\n');
  });

  it('truncates dock lines to the terminal width so they cannot wrap', () => {
    const out = fakeOut(40);
    const dock = new TerminalDock(out);
    dock.set(['x'.repeat(100)]);
    expect(out.written).toContain('x'.repeat(39));
    expect(out.written).not.toContain('x'.repeat(40));
  });

  it('release resets the region, clears the dock rows, and restores the cursor', () => {
    const out = fakeOut(40);
    const dock = new TerminalDock(out);
    dock.set(['ROW']);
    dock.release();
    expect(out.written).toContain('\x1b[r');
    expect(out.written).toContain('\x1b[?25h');
    expect(out.written).toContain('\x1b[24;1H\x1b[2K');
  });

  it('parks the real cursor at the caret and hops back for content writes', () => {
    const out = fakeOut(40); // 24 rows
    const dock = new TerminalDock(out);
    dock.set(['A', 'B'], { row: 2, col: 5 });
    // Dock occupies rows 23-24; caret row 2 of the dock = screen row 24.
    expect(out.written).toContain('\x1b[24;5H');
    expect(out.written).toContain('\x1b[?25h');
    const before = out.written.length;
    dock.log('hello');
    const logged = out.written.slice(before);
    // While parked, log restores the content position, writes, re-saves.
    expect(logged).toContain('\x1b8');
    expect(logged).toContain('hello\n');
    expect(logged).toContain('\x1b7');
  });

  it('repaint replays the last dock content and caret after an overdraw', () => {
    const out = fakeOut(40);
    const dock = new TerminalDock(out);
    dock.set(['DOCK-ROW'], { row: 1, col: 3 });
    const before = out.written.length;
    dock.repaint();
    const replay = out.written.slice(before);
    expect(replay).toContain('DOCK-ROW');
    expect(replay).toContain('\x1b[24;3H');
  });
});

describe('DockRenderer (pinned observability)', () => {
  it('emits durable lines and paints the live status inside the dock', () => {
    setColorEnabled(false);
    const out = fakeOut(80);
    const dock = new TerminalDock(out);
    const lines: string[] = [];
    const r = new DockRenderer(dock, (l) => lines.push(l), () => ({ meta: '● m', hints: 'h' }));
    r.turnStart(1, 40, 1200, 300);
    expect(lines.join('\n')).toContain('[turn 1/40');
    expect(out.written).toContain('turn 1/40'); // painted in the dock
    expect(out.written).toMatch(
      /Routing|Etching|Reflowing|Soldering|Drilling|Plating|Probing|Fluxing|Tinning|Laminating|Silkscreening|Panelizing/,
    );
    r.toolResult('run_erc', 'clean');
    expect(lines.some((l) => l.includes('run_erc'))).toBe(true);
    r.status('model call');
    r.heartbeat({ elapsedMs: 5000, streamedChars: 2100 });
    expect(out.written).toContain('model call');
    r.finish('done · verified erc');
    expect(lines[lines.length - 1]).toContain('done');
  });

  it('morphs the working word letter by letter through underscore slots', () => {
    setColorEnabled(false);
    vi.useFakeTimers();
    try {
      const out = fakeOut(80);
      const dock = new TerminalDock(out);
      const r = new DockRenderer(dock, () => {}, () => ({ meta: null, hints: null }));
      r.turnStart(1, 40, 0, 0);
      // Cross the ~6s word-rotation boundary; the transition erases the old
      // word into `_` slots before typing the next one.
      vi.advanceTimersByTime(6500);
      expect(out.written).toContain('_');
      // Settle mid-cycle (before the next rotation boundary at 12s).
      vi.advanceTimersByTime(4000);
      const tail = out.written.slice(-400);
      expect(tail).toMatch(
        /Routing|Etching|Reflowing|Soldering|Drilling|Plating|Probing|Fluxing|Tinning|Laminating|Silkscreening|Panelizing/,
      );
      r.finish('done');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('history scrolling', () => {
  it('PgUp shows older lines, any key snaps back to the live tail', async () => {
    const out = fakeOut(60); // 24 rows
    const hist = Array.from({ length: 60 }, (_, i) => `line-${i + 1}`);
    const dock = new TerminalDock(out);
    const line = await promptWithSlashHints({
      prompt: '> ',
      commands: SLASH_COMMANDS,
      output: out,
      dock,
      history: () => hist,
      readKey: keySequence(['\x1b[5~', 'x', '\r']),
    });
    expect(line).toBe('x');
    expect(out.written).toContain('history ↑');
    expect(out.written).toContain('line-21'); // scrolled window
    expect(out.written).toContain('line-60'); // live tail repainted on snap-back
  });
});

describe('theme + animation primitives', () => {
  it('theme tokens are plain when color is off and painted when on', () => {
    setColorEnabled(false);
    expect(bright('x')).toBe('x');
    expect(bold('x')).toBe('x');
    expect(copperLight('x')).toBe('x');
    expect(ruleDim('x')).toBe('x');
    setColorEnabled(true);
    try {
      for (const f of [bright, bold, copperLight, ruleDim, copper]) {
        expect(f('x')).toContain('\x1b[');
        expect(f('x')).toContain('\x1b[0m');
      }
    } finally {
      setColorEnabled(false);
    }
  });

  it('truncateVisible cuts by visible width and closes SGR', () => {
    expect(truncateVisible('abcdef', 4)).toBe('abcd');
    expect(truncateVisible('ab', 4)).toBe('ab');
    setColorEnabled(true);
    try {
      const cut = truncateVisible(copper('abcdef'), 3);
      expect(visibleWidth(cut)).toBe(3);
      expect(cut.endsWith('\x1b[0m')).toBe(true);
    } finally {
      setColorEnabled(false);
    }
  });

  it('animateMarkAt is a no-op when animation is disabled', async () => {
    setColorEnabled(false); // prefersAnimation() is false without color
    const out = fakeOut(40);
    await animateMarkAt(out, 2);
    expect(out.written).toBe('');
  });

  it('boot frames match the mark width and end on the exact mark', () => {
    setColorEnabled(false);
    const mark = fiducialMark();
    const frames = fiducialBootFrames();
    for (const frame of frames) {
      for (const row of frame) expect(visibleWidth(row)).toBe(visibleWidth(mark[0]!));
    }
    expect(frames[frames.length - 1]).toEqual(mark);
  });
});

describe('suggestionLines windowing', () => {
  it('caps long lists and reports the hidden count', () => {
    const lines = suggestionLines(SLASH_COMMANDS, 10, 8);
    const itemRows = lines.filter((l) => /  [❯ ] \//.test(l));
    expect(SLASH_COMMANDS.length).toBeGreaterThan(8);
    expect(itemRows.length).toBeLessThanOrEqual(8);
    expect(lines.join('\n')).toContain('more');
    // The hovered item stays visible inside the window.
    expect(lines.join('\n')).toContain(SLASH_COMMANDS[10]!.label);
  });

  it('keeps small lists unwindowed', () => {
    const lines = suggestionLines(SLASH_COMMANDS.slice(0, 3), 0, 8);
    expect(lines.join('\n')).not.toContain('more');
  });
});

describe('promptWithSlashHints in the dock', () => {
  it('shows the placeholder while empty and returns typed input', async () => {
    const out = fakeOut(60);
    const line = await promptWithSlashHints({
      prompt: '> ',
      commands: SLASH_COMMANDS,
      output: out,
      placeholder: 'Try "add a power LED"',
      readKey: keySequence(['a', '\r']),
    });
    expect(line).toBe('a');
    expect(out.written).toContain('Try "add a power LED"');
    // Full-width separator rules around the input line.
    expect(out.written).toContain('─'.repeat(59));
    // Submitted line committed to scrollback.
    expect(out.written).toContain('> a\n');
  });

  it('menu open/close overlays without ever scrolling (no newlines after activation)', async () => {
    const out = fakeOut(60);
    const dock = new TerminalDock(out);
    let activationEnd = -1;
    const origSet = dock.set.bind(dock);
    dock.set = (lines: string[], caret?: { row: number; col: number }) => {
      origSet(lines, caret);
      if (activationEnd < 0) activationEnd = out.written.length;
    };
    await promptWithSlashHints({
      prompt: '> ',
      commands: SLASH_COMMANDS,
      output: out,
      dock,
      status: () => ({ left: 'l', right: 'r' }),
      readKey: keySequence(['/', '\x1b[B', '\x1b', '\r']),
    });
    // After the first paint (activation may scroll to free bottom rows), the
    // menu opening, navigating, and closing must write zero newlines: only
    // absolute-addressed repaints. The single trailing \n is the submit echo.
    const after = out.written.slice(activationEnd);
    expect((after.match(/\n/g) ?? []).length).toBe(1);
    expect(after.endsWith('> \n')).toBe(true);
  });

  it('shrinking the dock clears the rows the menu occupied', () => {
    const out = fakeOut(40); // 24 rows
    const dock = new TerminalDock(out);
    dock.set(['A']); // fence [1,23]
    dock.set(['M1', 'M2', 'A']); // overlay grow: fence [1,21]
    const lenBefore = out.written.length;
    dock.set(['A']); // shrink back: rows 22-23 must be cleared
    const after = out.written.slice(lenBefore);
    expect(after).toContain('\x1b[22;1H\x1b[2K');
    expect(after).toContain('\x1b[23;1H\x1b[2K');
    expect(after).toContain('\x1b[1;23r');
    expect(after).not.toContain('\n');
  });

  it('renders the status bar under the input box', async () => {
    const out = fakeOut(60);
    await promptWithSlashHints({
      prompt: '> ',
      commands: SLASH_COMMANDS,
      output: out,
      status: () => ({ left: 'hints here', right: 'model-x' }),
      readKey: keySequence(['\r']),
    });
    expect(out.written).toContain('hints here');
    expect(out.written).toContain('model-x');
  });

  it('requires Ctrl+C twice to exit and clears the buffer first', async () => {
    const out = fakeOut(60);
    const line = await promptWithSlashHints({
      prompt: '> ',
      commands: SLASH_COMMANDS,
      output: out,
      readKey: keySequence(['a', '\x03', '\x03']),
    });
    expect(line).toBeNull();
    expect(out.written).toContain('press ctrl+c again to exit');
  });

  it('any key after Ctrl+C disarms the exit', async () => {
    const out = fakeOut(60);
    const line = await promptWithSlashHints({
      prompt: '> ',
      commands: SLASH_COMMANDS,
      output: out,
      readKey: keySequence(['\x03', 'x', '\r']),
    });
    expect(line).toBe('x');
  });

  it('paints the passive working row when a request is submitted', async () => {
    const out = fakeOut(60);
    const line = await promptWithSlashHints({
      prompt: '> ',
      commands: SLASH_COMMANDS,
      output: out,
      status: () => ({ left: 'l', right: 'r' }),
      readKey: keySequence(['h', 'i', '\r']),
    });
    expect(line).toBe('hi');
    expect(out.written).toContain('working — ctrl+c interrupts');
  });

  it('renders the right-aligned meta line above the input', async () => {
    const out = fakeOut(60);
    await promptWithSlashHints({
      prompt: '> ',
      commands: SLASH_COMMANDS,
      output: out,
      meta: () => '● model-y',
      readKey: keySequence(['\r']),
    });
    expect(out.written).toContain('● model-y');
  });

  it('wraps the hovered description to a second row instead of truncating', () => {
    const lines = suggestionLines(
      [{ value: '/x', label: '/x', description: 'D'.repeat(120) }],
      0,
      10,
      40,
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]!.trimEnd().endsWith('…')).toBe(true);
    // Unhovered rows stay single-line.
    const two = suggestionLines(
      [
        { value: '/x', label: '/x', description: 'D'.repeat(120) },
        { value: '/y', label: '/y', description: 'E'.repeat(120) },
      ],
      0,
      10,
      40,
    );
    const yRows = two.filter((l) => l.includes('/y'));
    expect(yRows).toHaveLength(1);
  });
});
