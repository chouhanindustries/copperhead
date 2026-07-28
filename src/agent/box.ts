/**
 * Box-drawing primitives for the bottom-docked REPL chrome: input box,
 * status bar, and notice callouts. All width math ignores SGR sequences so
 * colored segments never break padding or wrap accounting.
 */

import { copper, err, isColorEnabled, ruleDim, warn } from './theme.js';

const SGR = /\x1b\[[0-9;]*m/g;

/** Visible width ignoring SGR color codes. */
export function visibleWidth(s: string): number {
  return s.replace(SGR, '').length;
}

/** Inverse video (synthetic caret / hover); no-op when color is off. */
export function inverse(s: string): string {
  if (!isColorEnabled() || s === '') return s;
  return `\x1b[7m${s}\x1b[0m`;
}

/** A run of plain text with an optional style applied after slicing. */
export interface Span {
  text: string;
  paint?: (s: string) => string;
}

/**
 * Wrap styled spans into lines no wider than `width`. Styling is applied per
 * slice, so a span can be cut at a wrap boundary without leaking SGR state.
 */
export function wrapSpans(spans: Span[], width: number): string[] {
  const w = Math.max(1, width);
  const lines: string[] = [];
  let cur = '';
  let curLen = 0;
  for (const span of spans) {
    let text = span.text;
    while (text.length) {
      const take = text.slice(0, w - curLen);
      cur += span.paint ? span.paint(take) : take;
      curLen += take.length;
      text = text.slice(take.length);
      if (curLen >= w) {
        lines.push(cur);
        cur = '';
        curLen = 0;
      }
    }
  }
  if (cur !== '' || !lines.length) lines.push(cur);
  return lines;
}

/** Full-width horizontal rule (the input-area separators), #888888. */
export function rule(width: number): string {
  return ruleDim('─'.repeat(Math.max(1, width)));
}

/** Truncate to a visible width, keeping SGR sequences intact and closed. */
export function truncateVisible(s: string, width: number): string {
  if (visibleWidth(s) <= width) return s;
  let out = '';
  let vis = 0;
  let i = 0;
  let hadSgr = false;
  while (i < s.length && vis < width) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        out += m[0];
        hadSgr = true;
        i += m[0].length;
        continue;
      }
    }
    out += s[i];
    vis++;
    i++;
  }
  return out + (hadSgr ? '\x1b[0m' : '');
}

/** One status line with a left- and a right-justified half. */
export function statusBar(left: string, right: string, width: number): string {
  const w = Math.max(8, width);
  const l = visibleWidth(left);
  const r = visibleWidth(right);
  // Too narrow for both: the hints matter more than the meta.
  if (l + r + 2 > w) return truncateVisible(left, w);
  return left + ' '.repeat(w - l - r) + right;
}

/** Notice block: thin colored left bar + title + dim body (banner callouts). */
export function callout(kind: 'info' | 'warn' | 'err', title: string, body: string[]): string[] {
  const paintBar = kind === 'err' ? err : kind === 'warn' ? warn : copper;
  const bar = paintBar(' ▎');
  return [`${bar} ${paintBar(title)}`, ...body.map((b) => `${bar} ${b}`)];
}
