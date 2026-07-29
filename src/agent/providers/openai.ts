import { DEFAULT_API_KEY_ENV, isLocalEndpoint } from '../../config.js';
import type { ChatOpts, Msg, Provider, ToolSchema, Turn, ToolCall } from '../types.js';

/** Pointing the provider at an OpenAI-compatible endpoint (design D1). */
export interface OpenAIProviderOptions {
  /** Endpoint base URL; omitted means the client's own default (OpenAI). */
  baseURL?: string | undefined;
  /** Name of the env var holding the key. Never the key itself. */
  apiKeyEnv?: string | undefined;
}

/** The slice of a chat completion this provider reads. */
interface CompletionLike {
  choices: { message: { content?: string | null; tool_calls?: unknown[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/**
 * True for the errors a non-streaming endpoint answers with. Compat targets
 * (Groq, OpenRouter, a local Ollama, someone's vLLM) are OpenAI-shaped but not
 * OpenAI: a few reject `stream` or `stream_options` outright, and an
 * unverified OpenAI org is refused streaming by name. Those all mean "ask for
 * the whole answer at once", not "the run is broken".
 */
function refusesStreaming(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  const message = (err as Error).message ?? '';
  if (status !== undefined && status !== 400 && status !== 403 && status !== 404 && status !== 422) return false;
  return /stream/i.test(message);
}

export class OpenAIProvider implements Provider {
  readonly name: string;
  private readonly apiKey: string | undefined;
  private readonly baseURL: string | undefined;
  /** Latched once an endpoint refuses to stream, so it is asked exactly once. */
  private streamingRefused = false;

  constructor(
    private readonly model = 'gpt-5',
    opts: OpenAIProviderOptions = {},
    env: NodeJS.ProcessEnv = process.env,
  ) {
    // Credentials are always resolved through a named env var, never accepted
    // as a literal value: the one way to supply a key keeps application code
    // from ever holding one directly (mirrors AC-4.1 elsewhere). Tests inject
    // fake values through the `env` argument, not through opts.
    const keyEnv = opts.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
    this.baseURL = opts.baseURL;
    // A compat endpoint must be structurally ineligible for the paid
    // OpenAI/Anthropic failover in otherProvider() (loop.ts) — it is not
    // OpenAI, and a rate limit there must never silently redirect a run the
    // user deliberately pointed elsewhere to someone else's paid API.
    this.name = this.baseURL ? 'openai-compat' : 'openai';
    this.apiKey = env[keyEnv];
    // A loopback endpoint (Ollama) serves the same API with no credential, and
    // it is the one backend that is both free and fully local — requiring a
    // dummy key there would be a papercut on the most useful config (D4).
    if (!this.apiKey && !isLocalEndpoint(this.baseURL)) {
      throw new Error(`${keyEnv} is not set`);
    }
  }

  async chat(messages: Msg[], tools: ToolSchema[], opts: ChatOpts = {}): Promise<Turn> {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({
      // A local endpoint may legitimately have no key, but the client still
      // wants a non-empty string, so send a placeholder it will never check.
      apiKey: this.apiKey ?? 'no-key-required',
      ...(this.baseURL ? { baseURL: this.baseURL } : {}),
    });
    const body = {
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
                    tool_calls: m.toolCalls.map(serializeToolCall),
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
    };
    opts.raw?.({ kind: 'request', data: body });
    const { res, streamed } = await complete(client as never, body, opts, !this.streamingRefused);
    if (!streamed) this.streamingRefused = true;
    opts.raw?.({ kind: 'response', data: res });
    const choice = res.choices[0];
    // Capture any non-standard properties returned by the API (e.g. Gemini thought
    // signatures) so they can be echoed back on subsequent turns. Dropping them
    // causes reasoning-model backends to reject the follow-up request with 400.
    const toolCalls = ((choice?.message.tool_calls ?? []) as unknown as Record<string, unknown>[]).map(parseToolCall);
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

/**
 * Run one completion, streaming when the endpoint allows it (design: a turn
 * that takes two minutes should print as it arrives, not all at once when it
 * ends). `stream_options.include_usage` is what keeps token accounting honest
 * on the streamed path — without it the final chunk carries no usage and every
 * turn would report zero tokens.
 */
async function complete(
  client: {
    chat: {
      completions: {
        create(body: unknown): Promise<unknown>;
        stream(body: unknown): {
          on(event: 'content', cb: (delta: string) => void): unknown;
          finalChatCompletion(): Promise<unknown>;
        };
      };
    };
  },
  body: Record<string, unknown>,
  opts: ChatOpts,
  canStream: boolean,
): Promise<{ res: CompletionLike; streamed: boolean }> {
  if (canStream) {
    try {
      const stream = client.chat.completions.stream({ ...body, stream_options: { include_usage: true } });
      let chars = 0;
      stream.on('content', (delta: string) => {
        chars += delta.length;
        opts.onText?.(delta);
        opts.onStream?.(chars);
      });
      try {
        return { res: (await stream.finalChatCompletion()) as CompletionLike, streamed: true };
      } catch (err) {
        // A stream that carried no completion at all is the streamed spelling
        // of the empty-response case the caller already tolerates (the loop
        // nudges an empty turn and fails only on three in a row), so it is
        // reported rather than thrown — but it lands in raw.log, because the
        // other way to get here is a connection that died mid-request.
        if (/without producing a ChatCompletion|without sending any chunks/i.test((err as Error).message)) {
          opts.raw?.({ kind: 'stream-empty', data: (err as Error).message });
          return { res: { choices: [] }, streamed: true };
        }
        throw err;
      }
    } catch (err) {
      if (!refusesStreaming(err)) throw err;
      opts.raw?.({ kind: 'stream-refused', data: (err as Error).message });
    }
  }
  return { res: (await client.chat.completions.create(body)) as CompletionLike, streamed: false };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return { _raw: s };
  }
}

export function serializeToolCall(t: ToolCall) {
  return {
    id: t.id,
    type: 'function' as const,
    function: { name: t.name, arguments: JSON.stringify(t.args) },
    // Preserve vendor-specific tool-call fields (e.g. Gemini thought signatures).
    // Dropping them makes the next turn's request 400.
    ...(t.extra || {}),
  };
}

export function parseToolCall(t: Record<string, unknown>): ToolCall {
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
}
