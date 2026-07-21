import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Codex, type ThreadOptions, type TurnOptions } from '@openai/codex-sdk';
import type { ChatOpts, Msg, Provider, ToolCall, ToolSchema, Turn } from '../types.js';

interface CodexUsage {
  input_tokens: number;
  output_tokens: number;
}

interface CodexTurnLike {
  finalResponse: string;
  usage: CodexUsage | null;
}

interface CodexThreadLike {
  run(input: string, options?: TurnOptions): Promise<CodexTurnLike>;
}

interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
}

export interface CodexProviderOptions {
  /** Omit to use the model selected by the user's Codex configuration. */
  model?: string;
  /** Defaults to `codex` on PATH; override with COPPERHEAD_CODEX_PATH. */
  codexPath?: string;
  /** Isolated from the target repo so Codex cannot bypass Copperhead's read tools. */
  workingDirectory?: string;
  /** Test seam; production uses the official Codex SDK. */
  client?: CodexClientLike;
}

interface StructuredTurn {
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
}

/**
 * Uses the locally installed Codex CLI and its saved ChatGPT login. Codex is a
 * reasoning backend only: its own sandbox is read-only and Copperhead remains
 * the sole dispatcher for every file edit, KiCad check, and commit gate.
 */
export class CodexProvider implements Provider {
  readonly name = 'codex';

  private readonly model: string | undefined;
  private readonly workingDirectory: string;
  private readonly client: CodexClientLike;
  private thread: CodexThreadLike | null = null;
  private messageCursor = 0;

  constructor(options: CodexProviderOptions = {}) {
    this.model = options.model;
    this.workingDirectory = options.workingDirectory ?? path.join(tmpdir(), 'copperhead-codex-provider');
    this.client =
      options.client ??
      new Codex({
        // Intentionally use the user's installed CLI, not an API key or the
        // SDK's bundled binary. That is what reuses `codex login` state.
        codexPathOverride: options.codexPath || process.env.COPPERHEAD_CODEX_PATH || 'codex',
      });
  }

  async chat(messages: Msg[], tools: ToolSchema[], _opts: ChatOpts = {}): Promise<Turn> {
    await mkdir(this.workingDirectory, { recursive: true });
    if (!this.thread) {
      this.thread = this.client.startThread({
        ...(this.model ? { model: this.model } : {}),
        workingDirectory: this.workingDirectory,
        skipGitRepoCheck: true,
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        networkAccessEnabled: false,
        webSearchMode: 'disabled',
      });
    }

    const prompt = renderTurnPrompt(messages, this.messageCursor, tools);
    let result: CodexTurnLike;
    try {
      result = await this.thread.run(prompt, { outputSchema: turnSchema(tools) });
    } catch (err) {
      const original = err as Error & { status?: number; statusCode?: number };
      const enhanced = new Error(
        `Codex CLI provider failed: ${original.message}. Ensure codex is on PATH and authenticated (run: codex login status).`,
        { cause: err },
      );
      if (original.status !== undefined) Object.assign(enhanced, { status: original.status });
      if (original.statusCode !== undefined) Object.assign(enhanced, { statusCode: original.statusCode });
      throw enhanced;
    }

    // Advance only after a completed turn so a retry still receives the input.
    this.messageCursor = messages.length;
    const parsed = parseStructuredTurn(result.finalResponse, new Set(tools.map((tool) => tool.name)));
    return {
      text: parsed.text.trim() || null,
      toolCalls: parsed.toolCalls,
      usage: {
        inputTokens: result.usage?.input_tokens ?? 0,
        outputTokens: result.usage?.output_tokens ?? 0,
      },
    };
  }
}

function renderTurnPrompt(messages: Msg[], cursor: number, tools: ToolSchema[]): string {
  const unseen = messages.slice(cursor);
  const sections = [
    [
      'You are the reasoning backend inside Copperhead, not an independent coding agent.',
      'Do not use shell, filesystem, MCP, web, or file-editing capabilities from Codex itself.',
      'Request all actions only through the Copperhead tools listed below.',
      'Return one structured turn. `text` may contain a concise plan/status (or be empty).',
      'Each `toolCalls[].arguments` value must be a JSON-encoded object matching that tool schema.',
      'Never name a tool that is not in the current catalog.',
    ].join('\n'),
  ];

  if (cursor === 0) {
    for (const message of unseen) sections.push(renderInitialMessage(message));
  } else {
    const updates = unseen
      .filter((message) => message.role !== 'assistant')
      .map((message) => {
        if (message.role === 'tool') {
          return `<tool_result call_id="${message.toolCallId}">\n${message.content}\n</tool_result>`;
        }
        return `<${message.role}>\n${message.content}\n</${message.role}>`;
      });
    if (updates.length) sections.push(`New results and instructions since your previous turn:\n${updates.join('\n\n')}`);
  }

  sections.push(`Current Copperhead tool catalog:\n${JSON.stringify(tools, null, 2)}`);
  return sections.join('\n\n');
}

function renderInitialMessage(message: Msg): string {
  switch (message.role) {
    case 'system':
      return `<copperhead_system>\n${message.content}\n</copperhead_system>`;
    case 'user':
      return `<user_request>\n${message.content}\n</user_request>`;
    case 'assistant':
      return `<prior_assistant>\n${message.content ?? ''}\n${JSON.stringify(message.toolCalls ?? [])}\n</prior_assistant>`;
    case 'tool':
      return `<tool_result call_id="${message.toolCallId}">\n${message.content}\n</tool_result>`;
  }
}

function turnSchema(tools: ToolSchema[]): Record<string, unknown> {
  const names = tools.map((tool) => tool.name);
  return {
    type: 'object',
    properties: {
      text: { type: 'string' },
      toolCalls: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: names.length ? { type: 'string', enum: names } : { type: 'string' },
            arguments: { type: 'string' },
          },
          required: ['id', 'name', 'arguments'],
          additionalProperties: false,
        },
      },
    },
    required: ['text', 'toolCalls'],
    additionalProperties: false,
  };
}

function parseStructuredTurn(raw: string, allowedTools: Set<string>): { text: string; toolCalls: ToolCall[] } {
  let parsed: StructuredTurn;
  try {
    parsed = JSON.parse(raw) as StructuredTurn;
  } catch (err) {
    throw new Error(`Codex returned invalid structured output: ${(err as Error).message}`);
  }
  if (typeof parsed.text !== 'string' || !Array.isArray(parsed.toolCalls)) {
    throw new Error('Codex structured output is missing text or toolCalls');
  }
  const toolCalls = parsed.toolCalls.map((call, index) => {
    if (!call || typeof call.id !== 'string' || typeof call.name !== 'string' || typeof call.arguments !== 'string') {
      throw new Error(`Codex tool call ${index} has an invalid shape`);
    }
    if (!allowedTools.has(call.name)) {
      throw new Error(`Codex requested unavailable tool "${call.name}"`);
    }
    let args: unknown;
    try {
      args = JSON.parse(call.arguments);
    } catch (err) {
      throw new Error(`Codex tool call ${call.id} has invalid JSON arguments: ${(err as Error).message}`);
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error(`Codex tool call ${call.id} arguments must encode a JSON object`);
    }
    return { id: call.id, name: call.name, args: args as Record<string, unknown> };
  });
  return { text: parsed.text, toolCalls };
}
