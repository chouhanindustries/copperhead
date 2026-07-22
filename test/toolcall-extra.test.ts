import { describe, it, expect } from 'vitest';
import type { ToolCall } from '../src/agent/types.js';
import { serializeToolCall, parseToolCall } from '../src/agent/providers/openai.js';

describe('ToolCall extra field round-trip', () => {
  it('preserves extra properties when serializing for the API (outgoing)', () => {
    // Simulate a tool call returned by Gemini with a thinking signature
    const toolCall: ToolCall = {
      id: 'call_abc',
      name: 'search_files',
      args: { query: '.gitignore' },
      extra: { extra_content: { google: { thought_signature: 'sig123' } } },
    };

    const serialized = serializeToolCall(toolCall);

    expect(serialized.id).toBe('call_abc');
    expect(serialized.function.name).toBe('search_files');
    // The extra_content must survive the outgoing serialization
    expect((serialized as Record<string, unknown>).extra_content).toEqual({
      google: { thought_signature: 'sig123' },
    });
  });

  it('omits extra when no non-standard properties are present (outgoing)', () => {
    const toolCall: ToolCall = {
      id: 'call_def',
      name: 'read_file',
      args: { path: 'README.md' },
    };

    const serialized = serializeToolCall(toolCall);

    // No extra_content key should be present
    expect(Object.keys(serialized)).toEqual(['id', 'type', 'function']);
  });

  it('captures vendor-specific metadata when parsing from the API (incoming)', () => {
    const incomingApiPayload = {
      id: 'call_xyz',
      type: 'function',
      function: {
        name: 'propose_change',
        arguments: '{"what_changes": "fix something"}',
      },
      // Non-standard metadata returned by the provider
      extra_content: {
        google: { thought_signature: 'abc987' }
      },
      some_other_field: true
    };

    const parsed = parseToolCall(incomingApiPayload);

    expect(parsed.id).toBe('call_xyz');
    expect(parsed.name).toBe('propose_change');
    expect(parsed.args).toEqual({ what_changes: 'fix something' });
    
    // Everything else should be collected into the `extra` bag
    expect(parsed.extra).toEqual({
      extra_content: { google: { thought_signature: 'abc987' } },
      some_other_field: true
    });
  });
});
