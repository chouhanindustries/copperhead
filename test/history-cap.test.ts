import { describe, it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { capHistory, HISTORY_CAP_DEFAULTS, type HistoryCapOptions } from '../src/agent/history.js';
import { renderConversation, renderDelta } from '../src/agent/providers/tool-protocol.js';
import { runAgentLoop } from '../src/agent/loop.js';
import { runInit } from '../src/memory/scaffold.js';
import { tempFixtureRepo } from './helpers.js';
import type { Msg, Provider, Turn } from '../src/agent/types.js';

/**
 * Tight options so fixtures stay readable; the defaults are exercised
 * separately. Small, but still large enough to hold an elision marker: below
 * that, `clip` correctly declines to clip at all (covered by its own test).
 */
const opts: HistoryCapOptions = { maxToolResultChars: 400, maxToolArgChars: 300, keepRecent: 2 };

function read(id: string, path: string, body: string, range?: { start?: number; end?: number }): Msg[] {
  const args: Record<string, unknown> = { path };
  if (range?.start !== undefined) args.start_line = range.start;
  if (range?.end !== undefined) args.end_line = range.end;
  return [
    { role: 'assistant', content: null, toolCalls: [{ id, name: 'read_file', args }] },
    { role: 'tool', toolCallId: id, content: body },
  ];
}

/** Filler turns to push earlier messages out of the protected recent window. */
function filler(n: number): Msg[] {
  return Array.from({ length: n }, (_, i): Msg => ({ role: 'user', content: `filler ${i}` }));
}

describe('capHistory — invariants that keep it safe in front of any provider', () => {
  it('preserves length, order, roles, and tool-call ids exactly', () => {
    const msgs: Msg[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do the thing' },
      ...read('c1', 'a.kicad_sch', 'X'.repeat(5000)),
      ...read('c2', 'a.kicad_sch', 'Y'.repeat(5000)),
      ...filler(4),
    ];
    const { messages: out } = capHistory(msgs, opts);
    expect(out).toHaveLength(msgs.length);
    expect(out.map((m) => m.role)).toEqual(msgs.map((m) => m.role));
    expect(out.flatMap((m) => (m.role === 'tool' ? [m.toolCallId] : []))).toEqual(
      msgs.flatMap((m) => (m.role === 'tool' ? [m.toolCallId] : [])),
    );
    // Length parity is what keeps claude-code's resume index (`sentCount`,
    // consumed by renderDelta) pointing at the same message after capping.
    expect(renderDelta(out, msgs.length - 2)).not.toBe('');
  });

  it('never mutates the caller\'s array (the transcript keeps full fidelity)', () => {
    const body = 'Z'.repeat(5000);
    const msgs: Msg[] = [...read('c1', 'a.kicad_sch', body), ...read('c2', 'a.kicad_sch', 'new'), ...filler(2)];
    const before = JSON.parse(JSON.stringify(msgs)) as Msg[];
    capHistory(msgs, opts);
    expect(msgs).toEqual(before);
  });

  it('hands the provider structurally independent messages', () => {
    // A new array alone is not enough: if the message objects are shared, a
    // provider that mutates what it is handed rewrites the run's own history.
    const msgs: Msg[] = [
      { role: 'user', content: 'original user text' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', name: 'edit_file', args: { path: 'a.kicad_sch', new_string: 'original payload' } }],
      },
      { role: 'tool', toolCallId: 'c1', content: 'ok' },
      ...filler(2),
    ];
    const { messages: out } = capHistory(msgs, opts);

    // Simulate a badly behaved provider mutating every level it can reach.
    (out[0] as { content: string }).content = 'MUTATED';
    const call = out[1].role === 'assistant' ? out[1].toolCalls![0]! : null;
    call!.args.new_string = 'MUTATED';
    (out[2] as { content: string }).content = 'MUTATED';

    expect(msgs[0]).toEqual({ role: 'user', content: 'original user text' });
    expect(msgs[1].role === 'assistant' && msgs[1].toolCalls![0]!.args.new_string).toBe('original payload');
    expect(msgs[2].role === 'tool' && msgs[2].content).toBe('ok');
  });

  it('returns short conversations unchanged, but never as the caller\'s own array', () => {
    const msgs: Msg[] = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
    const { messages: out, stats } = capHistory(msgs, opts);
    expect(out).toEqual(msgs); // nothing was eligible to trim
    // A provider that mutates what it is handed must not be able to reach the
    // run's own history through it, even on the early-return path.
    expect(out).not.toBe(msgs);
    expect(stats).toEqual({ charsSaved: 0, superseded: 0, truncated: 0 });
  });
});

describe('capHistory — what it actually trims', () => {
  it('supersedes an earlier read of a path that is read again later', () => {
    const stale = 'OLD'.repeat(2000);
    const msgs: Msg[] = [...read('c1', 'a.kicad_sch', stale), ...read('c2', 'a.kicad_sch', 'CURRENT'), ...filler(2)];
    const { messages: out, stats } = capHistory(msgs, opts);
    const first = out[1];
    expect(first.role).toBe('tool');
    expect(first.role === 'tool' && first.content).toContain('superseded');
    expect(first.role === 'tool' && first.content).toContain('a.kicad_sch');
    expect(first.role === 'tool' && first.content).not.toContain('OLD');
    expect(stats.superseded).toBe(1);
    expect(stats.charsSaved).toBeGreaterThan(stale.length - 500);
  });

  it('keeps the newest read of a path in full even when older ones are dropped', () => {
    // The newest read is the model's only current view of the file; superseding
    // it would be actively wrong, not merely lossy.
    const msgs: Msg[] = [
      ...read('c1', 'a.kicad_sch', 'OLD'.repeat(2000)),
      ...read('c2', 'a.kicad_sch', 'NEWEST'.repeat(2000)),
      ...filler(6),
    ];
    const { messages: out } = capHistory(msgs, { ...opts, maxToolResultChars: 100000 });
    const newest = out[3];
    expect(newest.role === 'tool' && newest.content).toBe('NEWEST'.repeat(2000));
  });

  it('does not supersede a whole-file read with a later partial read', () => {
    // `read_file` honours start_line/end_line, so a later 20-line read does not
    // reproduce the whole file. Dropping the earlier read here would delete
    // content the model can still legitimately be relying on.
    const whole = 'WHOLE'.repeat(2000);
    const msgs: Msg[] = [
      ...read('c1', 'a.kicad_sch', whole),
      ...read('c2', 'a.kicad_sch', 'lines 100-120 only', { start: 100, end: 120 }),
      ...filler(2),
    ];
    const { messages: out, stats } = capHistory(msgs, { ...opts, maxToolResultChars: 100000 });
    expect(out[1].role === 'tool' && out[1].content).toBe(whole);
    expect(stats.superseded).toBe(0);
  });

  it('does not supersede a ranged read with a later disjoint range', () => {
    const first = 'FIRST'.repeat(500);
    const msgs: Msg[] = [
      ...read('c1', 'a.kicad_sch', first, { start: 1, end: 50 }),
      ...read('c2', 'a.kicad_sch', 'other lines', { start: 100, end: 120 }),
      ...filler(2),
    ];
    const { messages: out, stats } = capHistory(msgs, { ...opts, maxToolResultChars: 100000 });
    expect(out[1].role === 'tool' && out[1].content).toBe(first);
    expect(stats.superseded).toBe(0);
  });

  it('supersedes a ranged read when a later read covers it', () => {
    const narrow = 'NARROW'.repeat(500);
    const msgs: Msg[] = [
      ...read('c1', 'a.kicad_sch', narrow, { start: 10, end: 20 }),
      ...read('c2', 'a.kicad_sch', 'wider', { start: 1, end: 100 }),
      ...filler(2),
    ];
    const { messages: out, stats } = capHistory(msgs, { ...opts, maxToolResultChars: 100000 });
    expect(out[1].role === 'tool' && out[1].content).toContain('superseded');
    expect(stats.superseded).toBe(1);
  });

  it('does not let a failed later read supersede a successful earlier one', () => {
    // dispatchTool turns a throwing handler into an `error: ...` tool result, so
    // a read that failed looks structurally identical to one that succeeded.
    // Superseding on it would swap real content for a stub pointing at a read
    // the model never received.
    const good = 'GOOD'.repeat(2000);
    const msgs: Msg[] = [
      ...read('c1', 'a.kicad_sch', good),
      ...read('c2', 'a.kicad_sch', 'error: ENOENT: no such file or directory'),
      ...filler(2),
    ];
    const { messages: out, stats } = capHistory(msgs, { ...opts, maxToolResultChars: 100000 });
    expect(out[1].role === 'tool' && out[1].content).toBe(good);
    expect(stats.superseded).toBe(0);
  });

  it('treats a read with end_line but no start_line as a whole-file read', () => {
    // toolReadFile returns the entire file whenever start_line is absent, so
    // recording this as [1, 50] would understate it and let a later narrower
    // read wrongly supersede it.
    const whole = 'WHOLE'.repeat(2000);
    const msgs: Msg[] = [
      ...read('c1', 'a.kicad_sch', whole, { end: 50 }),
      ...read('c2', 'a.kicad_sch', 'lines 1-40', { start: 1, end: 40 }),
      ...filler(2),
    ];
    const { messages: out, stats } = capHistory(msgs, { ...opts, maxToolResultChars: 100000 });
    expect(out[1].role === 'tool' && out[1].content).toBe(whole);
    expect(stats.superseded).toBe(0);
  });

  it('does not supersede across different paths', () => {
    const msgs: Msg[] = [...read('c1', 'a.kicad_sch', 'A'.repeat(50)), ...read('c2', 'b.md', 'B'.repeat(50)), ...filler(2)];
    const { messages: out, stats } = capHistory(msgs, { ...opts, maxToolResultChars: 100000 });
    expect(out[1].role === 'tool' && out[1].content).toBe('A'.repeat(50));
    expect(stats.superseded).toBe(0);
  });

  it('clips an oversized tool result, keeping head and tail and saying so', () => {
    const body = `HEAD${'m'.repeat(5000)}TAIL`;
    const msgs: Msg[] = [
      { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'run_erc', args: {} }] },
      { role: 'tool', toolCallId: 'c1', content: body },
      ...filler(2),
    ];
    const { messages: out, stats } = capHistory(msgs, opts);
    const clipped = out[1];
    expect(clipped.role === 'tool' && clipped.content).toMatch(/^HEAD/);
    expect(clipped.role === 'tool' && clipped.content).toMatch(/TAIL$/);
    expect(clipped.role === 'tool' && clipped.content).toContain('characters elided');
    expect(clipped.role === 'tool' && clipped.content.length).toBeLessThan(body.length);
    expect(stats.truncated).toBe(1);
  });

  it('clips an oversized tool-call argument (a settled anchored edit payload)', () => {
    const payload = '(symbol (lib_id "Device:R"))'.repeat(200);
    const msgs: Msg[] = [
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', name: 'edit_file', args: { path: 'a.kicad_sch', new_string: payload } }],
      },
      { role: 'tool', toolCallId: 'c1', content: 'ok' },
      ...filler(2),
    ];
    const { messages: out, stats } = capHistory(msgs, opts);
    const call = out[0].role === 'assistant' ? out[0].toolCalls?.[0] : undefined;
    expect(String(call?.args.new_string).length).toBeLessThan(payload.length);
    expect(String(call?.args.new_string)).toContain('already applied');
    expect(call?.args.path).toBe('a.kicad_sch'); // short args pass through untouched
    expect(call?.name).toBe('edit_file');
    expect(stats.truncated).toBe(1);
  });

  it('never grows a barely-oversized value, and never reports a negative saving', () => {
    // The elision marker counts against the cap. Without that, a value one
    // character over the limit came back longer than it went in and
    // charsSaved went negative, so capping made the request bigger.
    const body = 'x'.repeat(opts.maxToolResultChars + 1);
    const msgs: Msg[] = [
      { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'run_erc', args: {} }] },
      { role: 'tool', toolCallId: 'c1', content: body },
      ...filler(2),
    ];
    const { messages: out, stats } = capHistory(msgs, opts);
    const got = out[1].role === 'tool' ? out[1].content : '';
    expect(got.length).toBeLessThanOrEqual(opts.maxToolResultChars);
    expect(got.length).toBeLessThan(body.length);
    expect(stats.charsSaved).toBeGreaterThan(0);
  });

  it('leaves a value whole when the cap is too small to hold a marker', () => {
    // Better to send the value intact than to replace it with a marker and
    // almost no content, or to grow it past its original size.
    const body = 'y'.repeat(500);
    const msgs: Msg[] = [
      { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'run_erc', args: {} }] },
      { role: 'tool', toolCallId: 'c1', content: body },
      ...filler(2),
    ];
    const { messages: out, stats } = capHistory(msgs, { ...opts, maxToolResultChars: 10 });
    expect(out[1].role === 'tool' && out[1].content).toBe(body);
    expect(stats.charsSaved).toBe(0);
  });

  it('leaves an unsettled tool call\'s arguments intact', () => {
    // A call with no result yet has not run, so the "already applied" argument
    // for clipping its payload does not hold: it is still the live instruction.
    const payload = '(symbol (lib_id "Device:R"))'.repeat(200);
    const msgs: Msg[] = [
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'pending', name: 'edit_file', args: { path: 'a.kicad_sch', new_string: payload } }],
      },
      ...filler(6), // pushes it well outside the recent window, but it stays unsettled
    ];
    const { messages: out, stats } = capHistory(msgs, opts);
    const call = out[0].role === 'assistant' ? out[0].toolCalls?.[0] : undefined;
    expect(String(call?.args.new_string)).toBe(payload);
    expect(stats.truncated).toBe(0);
  });

  it('leaves everything inside the recent window verbatim', () => {
    const body = 'R'.repeat(5000);
    const msgs: Msg[] = [
      ...filler(4),
      { role: 'assistant', content: null, toolCalls: [{ id: 'c9', name: 'read_file', args: { path: 'a.md' } }] },
      { role: 'tool', toolCallId: 'c9', content: body },
    ];
    const { messages: out, stats } = capHistory(msgs, opts);
    expect(out[out.length - 1].role === 'tool' && (out[out.length - 1] as { content: string }).content).toBe(body);
    expect(stats.charsSaved).toBe(0);
  });

  it('shrinks what a provider actually renders, end to end', () => {
    const msgs: Msg[] = [
      ...read('c1', 'a.kicad_sch', 'OLD'.repeat(3000)),
      ...read('c2', 'a.kicad_sch', 'NEW'.repeat(3000)),
      ...filler(2),
    ];
    const { messages: out } = capHistory(msgs, opts);
    expect(renderConversation(out).length).toBeLessThan(renderConversation(msgs).length / 2);
  });

  it('cuts a realistic schematic-stage conversation substantially, on the real defaults', () => {
    // Shaped like the observed create-pipeline runs: a 30kB schematic re-read
    // between anchored edits, each edit carrying a large payload, over enough
    // turns that the early reads are long settled.
    const sch = '(kicad_sch (symbol (lib_id "Device:R") (at 100 100 0)))\n'.repeat(600);
    const msgs: Msg[] = [];
    for (let i = 0; i < 6; i++) {
      msgs.push(...read(`r${i}`, 'hardware/board.kicad_sch', sch));
      msgs.push({
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: `e${i}`, name: 'edit_file', args: { path: 'hardware/board.kicad_sch', new_string: sch.slice(0, 9000) } },
        ],
      });
      msgs.push({ role: 'tool', toolCallId: `e${i}`, content: 'edit applied' });
    }
    const { messages: out, stats } = capHistory(msgs, HISTORY_CAP_DEFAULTS);
    const before = renderConversation(msgs).length;
    const after = renderConversation(out).length;
    expect(after).toBeLessThan(before * 0.35);
    expect(stats.superseded).toBeGreaterThan(0);
    expect(stats.truncated).toBeGreaterThan(0);
    // The most recent read must survive intact regardless of how much was cut.
    expect(renderConversation(out)).toContain(sch.slice(0, 200));
  });
});

describe('capHistory in the agent loop', () => {
  /** Reads a big file twice (so the first read is superseded), then rate-limits
   *  the third turn once before finishing. */
  function retryingProvider(): Provider & { seen: Msg[][] } {
    let turn = 0;
    let thrown = false;
    const seen: Msg[][] = [];
    return {
      name: 'scripted-429',
      seen,
      async chat(messages: Msg[]): Promise<Turn> {
        // Record what actually went over the wire, not just what was computed.
        seen.push(messages.map((m) => JSON.parse(JSON.stringify(m)) as Msg));
        turn++;
        const usage = { inputTokens: 100, outputTokens: 10 };
        if (turn <= 2) {
          return {
            text: null,
            toolCalls: [{ id: `read-${turn}`, name: 'read_file', args: { path: 'big.txt' } }],
            usage,
          };
        }
        if (!thrown) {
          thrown = true;
          throw Object.assign(new Error('rate limited'), { status: 429 });
        }
        return {
          text: null,
          toolCalls: [{ id: 'fin', name: 'finish', args: { outcome: 'done', summary: 'done' } }],
          usage,
        };
      },
    };
  }

  it('counts the saving once per attempt, so a retried turn is not under-reported', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      // Large enough that superseding the first read is a real saving.
      await writeFile(path.join(repo, 'big.txt'), 'a big file\n'.repeat(2000), 'utf8');
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'fixture'], { cwd: repo });

      const provider = retryingProvider();
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'read it twice, then get rate limited',
        model: 'gpt-5',
        provider,
        // Comfortably above 6: at maxTurns 6 the loop injects its
        // "only 5 turns remain" nudge, which adds a message and muddies the
        // identity assertions below.
        maxTurns: 20,
        log: () => {},
        meta: { command: 'do', modelSource: 'flag', version: '0.0.0-test', kicadCliVersion: '0.0.0' },
      });

      // Turn 3 is capped once, sent, rejected with a 429, then sent again. Both
      // requests genuinely kept those characters off the wire, so the run-level
      // total must reflect two attempts, not one.
      const body = 'a big file\n'.repeat(2000);
      expect(res.stats.capCharsSaved).toBeGreaterThan(body.length * 1.5);

      // The counter alone could be right while the provider was still handed the
      // uncapped history, so assert against what it actually received. The two
      // rate-limited attempts are the last two requests.
      const attempts = provider.seen.slice(-2);
      expect(attempts).toHaveLength(2);
      for (const sent of attempts) {
        const stubs = sent.filter((m) => m.role === 'tool' && m.content.includes('superseded'));
        expect(stubs).toHaveLength(1); // the first read was replaced
        expect(sent.some((m) => m.role === 'tool' && m.content === body)).toBe(true); // the second survives
        // Identity invariants must hold on the wire, not just in the unit tests.
        expect(sent).toHaveLength(6); // system, user, a1, t1, a2, t2
        expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'tool']);
        expect(sent.flatMap((m) => (m.role === 'tool' ? [m.toolCallId] : []))).toEqual(['read-1', 'read-2']);
      }
      // Both attempts sent the same capped view.
      expect(attempts[0]).toEqual(attempts[1]);
    } finally {
      await cleanup();
    }
  }, 20000);
});
