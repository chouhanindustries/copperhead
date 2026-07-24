import { describe, it, expect } from 'vitest';
import {
  CursorProvider,
  parseCursorStdout,
  subprocessEnv,
  type CursorRunLike,
} from '../src/agent/providers/cursor.js';
import { makeProvider } from '../src/agent/loop.js';
import type { Msg, ToolSchema } from '../src/agent/types.js';

const tools: ToolSchema[] = [
  {
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

const messages: Msg[] = [
  { role: 'system', content: 'You are copperhead.' },
  { role: 'user', content: 'inspect docs/SPEC.md' },
];

function fakeRun(out: { text: string; sessionId?: string; input?: number; output?: number }): CursorRunLike {
  return async () => ({
    text: out.text,
    sessionId: out.sessionId,
    usage: { inputTokens: out.input ?? 0, outputTokens: out.output ?? 0 },
  });
}

describe('CursorProvider — routing', () => {
  it('makeProvider routes cursor and cursor:<id>', async () => {
    expect(await makeProvider('cursor')).toBeInstanceOf(CursorProvider);
    expect((await makeProvider('cursor')).name).toBe('cursor');
    expect(await makeProvider('cursor:composer-2.5')).toBeInstanceOf(CursorProvider);
    await expect(makeProvider('cursor:')).rejects.toThrow('cursor model override cannot be empty');
  });

  it('passes cursor:<id> as the CLI model', async () => {
    let capturedModel: string | undefined;
    const provider = new CursorProvider('composer-2.5', async (args) => {
      capturedModel = args.model;
      return { text: 'ok', usage: { inputTokens: 1, outputTokens: 2 } };
    });
    await provider.chat(messages, tools);
    expect(capturedModel).toBe('composer-2.5');
  });
});

describe('CursorProvider — tool protocol', () => {
  it('maps a JSON tool block in the result to Turn.toolCalls', async () => {
    const provider = new CursorProvider(
      undefined,
      fakeRun({
        text: '```json\n{"tool":"read_file","args":{"path":"docs/SPEC.md"}}\n```',
        sessionId: 'sess-1',
        input: 10,
        output: 5,
      }),
    );
    const turn = await provider.chat(messages, tools);
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]?.name).toBe('read_file');
    expect(turn.usage.inputTokens).toBe(10);
  });

  it('resumes with --resume after the first turn', async () => {
    const resumes: string[] = [];
    const runFn: CursorRunLike = async (args) => {
      if (args.resume) resumes.push(args.resume);
      return {
        text: 'ok',
        sessionId: resumes.length ? 'sess-1' : 'sess-1',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    };
    const provider = new CursorProvider(undefined, runFn);
    await provider.chat(messages, tools);
    await provider.chat(
      [...messages, { role: 'assistant', content: 'ok', toolCalls: [] }, { role: 'user', content: 'next' }],
      tools,
    );
    expect(resumes).toEqual(['sess-1']);
  });

  it('tripwire throws on native tool_call events in stdout JSON', () => {
    const line = JSON.stringify({ type: 'tool_call', name: 'Write' });
    expect(() => parseCursorStdout(line)).toThrow(/reasoning-only invariant/);
  });
});

describe('CursorProvider — env and lifecycle', () => {
  it('subprocessEnv allowlists CLI vars and omits billed or unrelated secrets', () => {
    const prev = { ...process.env };
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.CURSOR_API_KEY = 'key';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    try {
      const env = subprocessEnv();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.CURSOR_API_KEY).toBeUndefined();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.HOME).toBe(process.env.HOME);
    } finally {
      process.env.ANTHROPIC_API_KEY = prev.ANTHROPIC_API_KEY;
      process.env.OPENAI_API_KEY = prev.OPENAI_API_KEY;
      process.env.CURSOR_API_KEY = prev.CURSOR_API_KEY;
      delete process.env.AWS_SECRET_ACCESS_KEY;
    }
  });

  it('has a distinct name so keyed failover does not apply', () => {
    expect(new CursorProvider().name).toBe('cursor');
  });

  it('parseCursorStdout reads result JSON', () => {
    const stdout = JSON.stringify({
      type: 'result',
      result: 'hello',
      session_id: 'abc',
    });
    const parsed = parseCursorStdout(stdout);
    expect(parsed.text).toBe('hello');
    expect(parsed.sessionId).toBe('abc');
    expect(parsed.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('surfaces CLI-not-found guidance when agent binary is missing', async () => {
    const missing = Object.assign(new Error('spawn agent ENOENT'), { code: 'ENOENT' });
    const provider = new CursorProvider(undefined, async () => Promise.reject(missing));
    await expect(provider.chat(messages, tools)).rejects.toThrow(/Cursor Agent CLI not found/);
  });
});
