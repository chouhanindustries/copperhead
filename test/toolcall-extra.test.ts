import { describe, it, expect } from 'vitest';
import type { ToolCall, Msg } from '../src/agent/types.js';

describe('ToolCall extra field round-trip', () => {
  it('preserves extra properties through assistant message serialization', () => {
    // Simulate a tool call returned by Gemini with a thinking signature
    const toolCall: ToolCall = {
      id: 'call_abc',
      name: 'search_files',
      args: { query: '.gitignore' },
      extra: { extra_content: { google: { thought_signature: 'sig123' } } },
    };

    // Build the assistant message the way OpenAIProvider does
    const assistantMsg: Msg = {
      role: 'assistant',
      content: null,
      toolCalls: [toolCall],
    };

    // Serialize the tool_calls the same way openai.ts does
    const serialized = assistantMsg.role === 'assistant' && assistantMsg.toolCalls
      ? assistantMsg.toolCalls.map((t) => ({
          id: t.id,
          type: 'function' as const,
          function: { name: t.name, arguments: JSON.stringify(t.args) },
          ...(t.extra || {}),
        }))
      : [];

    // The extra_content must survive the round-trip
    expect(serialized).toHaveLength(1);
    expect(serialized[0].id).toBe('call_abc');
    expect(serialized[0].function.name).toBe('search_files');
    expect((serialized[0] as Record<string, unknown>).extra_content).toEqual({
      google: { thought_signature: 'sig123' },
    });
  });

  it('omits extra when no non-standard properties are present', () => {
    const toolCall: ToolCall = {
      id: 'call_def',
      name: 'read_file',
      args: { path: 'README.md' },
    };

    expect(toolCall.extra).toBeUndefined();

    const serialized = {
      id: toolCall.id,
      type: 'function' as const,
      function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) },
      ...(toolCall.extra || {}),
    };

    // No extra_content key should be present
    expect(Object.keys(serialized)).toEqual(['id', 'type', 'function']);
  });
});
