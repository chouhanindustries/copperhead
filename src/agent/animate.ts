/**
 * Subtle TTY motion for attended copperhead chrome. Disabled when color is
 * off, stdout is not a TTY, CI=1, or COPPERHEAD_NO_ANIM=1.
 */

import { copper, isColorEnabled } from './theme.js';

export function prefersAnimation(): boolean {
  return (
    isColorEnabled() &&
    Boolean(process.stdout.isTTY) &&
    !process.env.CI &&
    !process.env.COPPERHEAD_NO_ANIM
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';

/** Growing fiducial frames (3 rows), converging on the block mark. Exported for tests. */
export function fiducialBootFrames(): string[][] {
  return [
    ['         ', '    ██   ', '         '],
    ['   ▗▄▄▖  ', '   █  █  ', '   ▝▀▀▘  '],
    ['   ▄▟▙▄  ', '  ██  ██ ', '   ▀▜▛▀  '],
    ['   ▄▟▙▄  ', ' ███  ███', '   ▀▜▛▀  '],
  ].map((frame) => frame.map((row) => copper(row)));
}

/**
 * Pulse the fiducial mark in place over the already-rendered banner (rows
 * `topRow..topRow+2`, column 1). The full screen loads first; this animates
 * after, two grow cycles ending on the final mark. Frames are constant
 * width so they overwrite each other without clearing the banner text
 * beside them. Deliberately avoids DECSC/DECRC: the dock owns that slot for
 * its caret-parking protocol; the caller repaints the dock afterwards to
 * restore the caret.
 */
export async function animateMarkAt(
  out: NodeJS.WriteStream,
  topRow: number,
  opts?: { slow?: boolean },
): Promise<void> {
  if (!prefersAnimation()) return;
  const frames = fiducialBootFrames();
  const frameMs = opts?.slow ? 110 : 45;
  const holdMs = opts?.slow ? 220 : 90;
  try {
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const frame of frames) {
        let seq = HIDE;
        frame.forEach((row, i) => {
          seq += `\x1b[${topRow + i};1H${row}`;
        });
        out.write(seq);
        await sleep(frameMs);
      }
    }
    await sleep(holdMs);
  } finally {
    // Never leave the terminal with a hidden cursor, even if a write or
    // sleep throws mid-animation.
    out.write(SHOW);
  }
}

/** Copper horizontal rule (PCB-trace vibe). */
export function traceRule(width = 32): string {
  return copper('  ' + '─'.repeat(Math.max(8, Math.min(width, 48))));
}

/** Cascade lines (help / demo sections). Instant when animation is off. */
export async function staggerWrite(
  lines: string[],
  write: (line: string) => void,
  delayMs = 12,
): Promise<void> {
  if (!prefersAnimation()) {
    for (const line of lines) write(line);
    return;
  }
  for (const line of lines) {
    write(line);
    await sleep(delayMs);
  }
}
