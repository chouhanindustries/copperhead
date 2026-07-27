/**
 * Minimal arrow-key select menu for TTY prompts (no extra deps).
 * Renders an in-place "dropdown" navigable with ↑/↓ + Enter.
 */

import { copper, dim } from '../agent/theme.js';

export interface SelectItem {
  value: string;
  label: string;
  description?: string;
}

export interface SelectOptions {
  title?: string;
  items: SelectItem[];
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  /** Injected key stream for tests. */
  keys?: AsyncIterable<string>;
}

const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';
const CLEAR_LINE = '\r\x1b[2K';

function menuLines(title: string, items: SelectItem[], index: number): string[] {
  const width = Math.max(...items.map((i) => i.label.length), 8);
  return [
    copper(`  ${title}`),
    dim('  ↑/↓ move · Enter select · Esc cancel'),
    '',
    ...items.map((item, i) => {
      const cursor = i === index ? copper('❯') : ' ';
      const label = i === index ? copper(item.label.padEnd(width)) : dim(item.label.padEnd(width));
      const desc = item.description ? dim(`  ${item.description}`) : '';
      return `  ${cursor} ${label}${desc}`;
    }),
    '',
  ];
}

async function* stdinKeys(input: NodeJS.ReadStream): AsyncGenerator<string> {
  // Listener-based on purpose: `for await` over a Readable destroys the
  // stream when the consumer breaks out, which would kill stdin for
  // whatever runs after the menu (e.g. the REPL's KeyReader).
  const wasRaw = input.isRaw;
  if (typeof input.setRawMode === 'function') input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');

  const queue: string[] = [];
  let ended = false;
  let notify: (() => void) | null = null;
  const onData = (c: string | Buffer): void => {
    queue.push(String(c));
    notify?.();
  };
  const onEnd = (): void => {
    ended = true;
    notify?.();
  };
  input.on('data', onData);
  input.on('end', onEnd);

  try {
    for (;;) {
      while (queue.length) {
        const s = queue.shift()!;
        let i = 0;
        while (i < s.length) {
          if (s[i] === '\x1b' && s[i + 1] === '[') {
            yield s.slice(i, i + 3);
            i += 3;
            continue;
          }
          // Lone Esc
          if (s[i] === '\x1b') {
            yield '\x1b';
            i += 1;
            continue;
          }
          yield s[i]!;
          i += 1;
        }
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
      notify = null;
    }
  } finally {
    input.off('data', onData);
    input.off('end', onEnd);
    input.pause();
    if (typeof input.setRawMode === 'function') input.setRawMode(wasRaw ?? false);
  }
}

/** Model choices offered when no model is configured anywhere. */
export const MODEL_CHOICES: SelectItem[] = [
  { value: 'claude-code', label: 'claude-code', description: 'Claude Code CLI (saved login)' },
  { value: 'codex', label: 'codex', description: 'Codex CLI (saved login)' },
  { value: 'cursor', label: 'cursor', description: 'Cursor CLI (saved login)' },
  { value: 'claude', label: 'claude', description: 'Anthropic API (needs ANTHROPIC_API_KEY)' },
  { value: 'gpt-5', label: 'gpt-5', description: 'OpenAI API (needs OPENAI_API_KEY)' },
];

/**
 * Interactive model picker for a TTY session with no configured model.
 * Resolves to the chosen model id, or null if cancelled.
 */
export async function pickModel(opts: Omit<SelectOptions, 'title' | 'items'> = {}): Promise<string | null> {
  return selectMenu({ title: 'Select a model for this session', items: MODEL_CHOICES, ...opts });
}

/**
 * Show a selectable list. Resolves to the chosen value, or null if cancelled.
 */
export async function selectMenu(opts: SelectOptions): Promise<string | null> {
  const items = opts.items;
  if (!items.length) return null;

  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const title = opts.title ?? 'Select';
  let index = 0;
  let lineCount = 0;

  const paint = (): void => {
    const lines = menuLines(title, items, index);
    if (lineCount > 0) {
      // Move to the first line of the previous paint and rewrite in place.
      output.write(`\x1b[${lineCount}A`);
    }
    output.write(HIDE);
    for (const line of lines) {
      output.write(CLEAR_LINE + line + '\n');
    }
    lineCount = lines.length;
  };

  const erase = (): void => {
    if (lineCount <= 0) {
      output.write(SHOW);
      return;
    }
    output.write(`\x1b[${lineCount}A`);
    for (let i = 0; i < lineCount; i++) output.write(CLEAR_LINE + (i < lineCount - 1 ? '\n' : ''));
    if (lineCount > 1) output.write(`\x1b[${lineCount - 1}A`);
    output.write('\r' + SHOW);
    lineCount = 0;
  };

  paint();

  const keys = opts.keys ?? stdinKeys(input);
  try {
    for await (const key of keys) {
      if (key === '\x03' || key === '\x1b') {
        erase();
        return null;
      }
      if (key === '\r' || key === '\n') {
        const chosen = items[index]!.value;
        erase();
        return chosen;
      }
      if (key === '\x1b[A' || key === 'k') {
        index = (index - 1 + items.length) % items.length;
        paint();
        continue;
      }
      if (key === '\x1b[B' || key === 'j') {
        index = (index + 1) % items.length;
        paint();
        continue;
      }
      if (key >= '1' && key <= '9') {
        const n = Number(key) - 1;
        if (n >= 0 && n < items.length) {
          index = n;
          paint();
        }
      }
    }
  } finally {
    erase();
  }
  return null;
}
