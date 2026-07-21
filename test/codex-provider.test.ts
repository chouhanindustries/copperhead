import { describe, expect, it, vi } from 'vitest';
import { CodexProvider } from '../src/agent/providers/codex.js';
import { makeProvider } from '../src/agent/loop.js';
import type { Msg, ToolSchema } from '../src/agent/types.js';

const readTool: ToolSchema = {
  name: 'read_file',
  description: 'Read a file',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};

describe('CodexProvider', () => {
  it('is selected by the codex model namespace without an API key', () => {
    expect(makeProvider('codex').name).toBe('codex');
    expect(makeProvider('codex:gpt-test').name).toBe('codex');
    expect(() => makeProvider('codex:')).toThrow('codex model override cannot be empty');
  });

  it('uses a read-only Codex thread and maps structured tool calls', async () => {
    const run = vi.fn().mockResolvedValue({
      finalResponse: JSON.stringify({
        text: 'I will inspect the design.',
        toolCalls: [{ id: 'call-1', name: 'read_file', arguments: '{"path":"docs/SPEC.md"}' }],
      }),
      usage: { input_tokens: 120, output_tokens: 24 },
    });
    const startThread = vi.fn().mockReturnValue({ run });
    const provider = new CodexProvider({
      model: 'gpt-test',
      workingDirectory: process.cwd(),
      client: { startThread },
    });
    const messages: Msg[] = [
      { role: 'system', content: 'system policy' },
      { role: 'user', content: 'inspect the design' },
    ];

    const turn = await provider.chat(messages, [readTool]);

    expect(provider.name).toBe('codex');
    expect(startThread).toHaveBeenCalledWith({
      model: 'gpt-test',
      workingDirectory: process.cwd(),
      skipGitRepoCheck: true,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
    });
    expect(run.mock.calls[0]![0]).toContain('Do not use shell, filesystem, MCP, web');
    expect(run.mock.calls[0]![0]).toContain('system policy');
    expect(run.mock.calls[0]![0]).toContain('read_file');
    const schema = run.mock.calls[0]![1].outputSchema as {
      properties: { toolCalls: { items: { properties: { name: { enum: string[] } } } } };
    };
    expect(schema.properties.toolCalls.items.properties.name.enum).toEqual(['read_file']);
    expect(turn).toEqual({
      text: 'I will inspect the design.',
      toolCalls: [{ id: 'call-1', name: 'read_file', args: { path: 'docs/SPEC.md' } }],
      usage: { inputTokens: 120, outputTokens: 24 },
    });
  });

  it('continues the same thread with tool results without replaying assistant output', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        finalResponse: JSON.stringify({
          text: '',
          toolCalls: [{ id: 'call-1', name: 'read_file', arguments: '{"path":"docs/SPEC.md"}' }],
        }),
        usage: null,
      })
      .mockResolvedValueOnce({
        finalResponse: JSON.stringify({ text: 'done', toolCalls: [] }),
        usage: null,
      });
    const provider = new CodexProvider({
      workingDirectory: process.cwd(),
      client: { startThread: () => ({ run }) },
    });
    const initial: Msg[] = [
      { role: 'system', content: 'system policy' },
      { role: 'user', content: 'inspect the design' },
    ];
    await provider.chat(initial, [readTool]);
    await provider.chat(
      [
        ...initial,
        {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'call-1', name: 'read_file', args: { path: 'docs/SPEC.md' } }],
        },
        { role: 'tool', toolCallId: 'call-1', content: 'file contents' },
      ],
      [readTool],
    );

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![0]).toContain('<tool_result call_id="call-1">');
    expect(run.mock.calls[1]![0]).toContain('file contents');
    expect(run.mock.calls[1]![0]).not.toContain('<prior_assistant>');
  });

  it('rejects a tool name outside the currently exposed catalog', async () => {
    const provider = new CodexProvider({
      workingDirectory: process.cwd(),
      client: {
        startThread: () => ({
          run: async () => ({
            finalResponse: JSON.stringify({
              text: '',
              toolCalls: [{ id: 'call-1', name: 'edit_file', arguments: '{}' }],
            }),
            usage: null,
          }),
        }),
      },
    });

    await expect(provider.chat([{ role: 'user', content: 'edit' }], [readTool])).rejects.toThrow(
      'unavailable tool "edit_file"',
    );
  });

  it('rejects malformed JSON tool arguments', async () => {
    const provider = new CodexProvider({
      workingDirectory: process.cwd(),
      client: {
        startThread: () => ({
          run: async () => ({
            finalResponse: JSON.stringify({
              text: '',
              toolCalls: [{ id: 'call-1', name: 'read_file', arguments: '{nope' }],
            }),
            usage: null,
          }),
        }),
      },
    });

    await expect(provider.chat([{ role: 'user', content: 'read' }], [readTool])).rejects.toThrow(
      'invalid JSON arguments',
    );
  });

  it('preserves rate-limit status for the shared retry wrapper', async () => {
    const rateLimit = Object.assign(new Error('rate limited'), { status: 429 });
    const provider = new CodexProvider({
      workingDirectory: process.cwd(),
      client: { startThread: () => ({ run: async () => Promise.reject(rateLimit) }) },
    });

    await expect(provider.chat([{ role: 'user', content: 'read' }], [readTool])).rejects.toMatchObject({ status: 429 });
  });
});
