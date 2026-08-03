import { describe, it, expect } from 'vitest';
import { capHistory, HISTORY_CAP_DEFAULTS, type HistoryCapOptions } from '../src/agent/history.js';
import { renderConversation, renderDelta } from '../src/agent/providers/tool-protocol.js';
import type { Msg } from '../src/agent/types.js';

/** Tight options so fixtures stay readable; the defaults are exercised separately. */
const opts: HistoryCapOptions = { maxToolResultChars: 100, maxToolArgChars: 80, keepRecent: 2 };

function read(id: string, path: string, body: string): Msg[] {
  return [
    { role: 'assistant', content: null, toolCalls: [{ id, name: 'read_file', args: { path } }] },
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

  it('returns short conversations untouched, by identity', () => {
    const msgs: Msg[] = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
    const { messages: out, stats } = capHistory(msgs, opts);
    expect(out).toBe(msgs); // same reference: nothing was eligible
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
