/**
 * Bottom-of-viewport dock built on DECSTBM scroll regions: content is fenced
 * into rows [1, H - dockHeight] and the dock is painted with absolute cursor
 * addressing below the scroll margin, so no amount of content output (or
 * mouse wheel) can ever move it. Runs inside the alternate screen buffer the
 * REPL enters at startup. This is the FrankenTUI/ratatui-inline technique;
 * see also DECSTBM (CSI r).
 */

import { truncateVisible } from '../agent/box.js';

const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';
/** Synchronized-output guards; terminals without support ignore them. */
const SYNC_ON = '\x1b[?2026h';
const SYNC_OFF = '\x1b[?2026l';
/** Reset the scroll region to the full screen. Homes the cursor (hence DECSC/DECRC around it). */
const REGION_RESET = '\x1b[r';
const SAVE = '\x1b7';
const RESTORE = '\x1b8';

export class TerminalDock {
  /** Rows the dock currently occupies at the bottom of the screen. */
  private dockH = 0;
  /**
   * True while the real cursor is parked at a caret position inside the dock
   * (the DECSC slot then holds the content-region position to return to).
   */
  private parked = false;
  /** Last set() payload, replayable after an external overdraw (animations). */
  private last: { lines: string[]; caret?: { row: number; col: number } } | null = null;

  constructor(private readonly out: NodeJS.WriteStream) {}

  cols(): number {
    return typeof this.out.columns === 'number' && this.out.columns ? this.out.columns : 80;
  }

  rows(): number {
    return typeof this.out.rows === 'number' && this.out.rows ? this.out.rows : 24;
  }

  /**
   * Replace the docked region. On a height change the content scroll region
   * is re-fenced; same-height repaints are pure absolute-addressed writes and
   * can never scroll anything. With `caret` (dock-relative 1-based row and
   * column) the real terminal cursor is left parked there, Claude Code-style.
   */
  set(lines: string[], caret?: { row: number; col: number }): void {
    if (!lines.length) {
      this.release();
      return;
    }
    const h = this.rows();
    const shown = lines.slice(0, Math.max(1, h - 3)).map((l) => truncateVisible(l, this.cols() - 1));
    const newH = shown.length;

    let seq = SYNC_ON + HIDE;
    if (this.parked) {
      // Return to the content position first so the SAVE/RESTORE pairs below
      // keep preserving it, not the old caret.
      seq += RESTORE;
      this.parked = false;
    }
    if (this.dockH === 0) {
      // First activation: free the bottom rows by scrolling exactly as much
      // as needed (preserves the banner above), then fence content into
      // [1, h - newH]. DECSTBM homes the cursor; save/restore keeps it.
      seq += SAVE + REGION_RESET + RESTORE;
      seq += '\n'.repeat(newH) + `\x1b[${newH}A`;
      seq += SAVE + `\x1b[1;${h - newH}r` + RESTORE;
    } else if (newH !== this.dockH) {
      // Height change while active (menu open/close): overlay mode. Re-fence
      // and clear any rows freed by a shrink; never scroll content.
      seq += SAVE + `\x1b[1;${h - newH}r`;
      for (let r = h - Math.max(this.dockH, newH) + 1; r <= h - newH; r++) {
        seq += `\x1b[${r};1H\x1b[2K`;
      }
      seq += RESTORE;
    }
    seq += SAVE;
    for (let i = 0; i < newH; i++) {
      seq += `\x1b[${h - newH + 1 + i};1H\x1b[2K${shown[i]!}`;
    }
    seq += RESTORE;
    if (caret) {
      const row = Math.min(h, h - newH + Math.max(1, caret.row));
      const col = Math.max(1, Math.min(this.cols(), caret.col));
      seq += SAVE + `\x1b[${row};${col}H`;
      this.parked = true;
    }
    seq += SHOW + SYNC_OFF;
    this.out.write(seq);
    this.dockH = newH;
    this.last = caret ? { lines, caret } : { lines };
  }

  /** Replay the last set() (e.g. after an animation overdrew part of the screen). */
  repaint(): void {
    if (this.last) this.set(this.last.lines, this.last.caret);
  }

  /** Rows available to content above the dock. */
  contentRows(): number {
    return Math.max(1, this.rows() - this.dockH);
  }

  /**
   * Absolute-paint the whole content region (rows 1..contentRows) from the
   * given lines — used by history scrolling to show any window of the session
   * log. Does not touch the DECSC slot or the fence; callers repaint() the
   * dock afterwards to restore the caret.
   */
  paintContent(lines: string[]): void {
    const rowsN = this.contentRows();
    const shown = lines.slice(-rowsN).map((l) => truncateVisible(l, this.cols() - 1));
    let seq = SYNC_ON + HIDE;
    for (let r = 1; r <= rowsN; r++) {
      seq += `\x1b[${r};1H\x1b[2K${shown[r - 1] ?? ''}`;
    }
    seq += SYNC_OFF;
    this.out.write(seq);
  }

  /**
   * Write a scrollback line above the dock. With the fence in place a plain
   * write cannot touch the dock rows; if the cursor is parked at the caret,
   * hop back to the content region for the write and re-park after.
   */
  log(line: string): void {
    if (!this.parked) {
      this.out.write(line + '\n');
      return;
    }
    this.out.write(SYNC_ON + RESTORE + line + '\n' + SAVE + SYNC_OFF);
    // The slot now holds the advanced content position; the caret will be
    // re-established by the next set() with a caret argument.
    this.parked = false;
  }

  /** Drop the fence, clear the dock rows, and restore the cursor. */
  release(): void {
    if (!this.dockH) {
      this.out.write(SHOW);
      return;
    }
    const h = this.rows();
    let seq = SYNC_ON;
    if (this.parked) {
      seq += RESTORE;
      this.parked = false;
    }
    seq += SAVE + REGION_RESET + RESTORE;
    seq += SAVE;
    for (let r = h - this.dockH + 1; r <= h; r++) seq += `\x1b[${r};1H\x1b[2K`;
    seq += RESTORE + SHOW + SYNC_OFF;
    this.out.write(seq);
    this.dockH = 0;
    this.last = null;
  }
}
