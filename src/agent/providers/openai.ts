import type { ChatOpts, Msg, Provider, ToolSchema, Turn } from '../types.js';

export class OpenAIProvider implements Provider {
  readonly name = 'openai';

  constructor(
    private readonly model = 'gpt-5',
    private readonly apiKey = process.env.OPENAI_API_KEY,
  ) {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is not set');
  }

  async chat(messages: Msg[], tools: ToolSchema[], opts: ChatOpts = {}): Promise<Turn> {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: this.apiKey });
    const res = await client.chat.completions.create({
      model: this.model,
      max_completion_tokens: opts.maxTokens ?? 8192,
      messages: messages.map((m) => {
        switch (m.role) {
          case 'system':
            return { role: 'system' as const, content: m.content };
          case 'user':
            return { role: 'user' as const, content: m.content };
          case 'assistant':
            return {
              role: 'assistant' as const,
              content: m.content,
              ...(m.toolCalls?.length
                ? {
                    tool_calls: m.toolCalls.map((t) => ({
                      id: t.id,
                      type: 'function' as const,
                      function: { name: t.name, arguments: JSON.stringify(t.args) },
                      ...(t.extra || {}),
                    })),
                  }
                : {}),
            };
          case 'tool':
            return { role: 'tool' as const, tool_call_id: m.toolCallId, content: m.content };
        }
      }),
      ...(tools.length
        ? {
            tools: tools.map((t) => ({
              type: 'function' as const,
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
    });
    const choice = res.choices[0];
    const toolCalls = ((choice?.message.tool_calls ?? []) as unknown as Record<string, unknown>[]).map((t: Record<string, unknown>) => {
      const extra: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(t)) {
        if (k !== 'id' && k !== 'type' && k !== 'function') {
          extra[k] = v;
        }
      }
      const fn = t.function as { name: string; arguments: string };
      return {
        id: t.id as string,
        name: fn.name,
        args: safeParse(fn.arguments),
        ...(Object.keys(extra).length ? { extra } : {}),
      };
    });
    return {
      text: choice?.message.content ?? null,
      toolCalls,
      usage: {
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
      },
    };
  }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return { _raw: s };
  }
}
