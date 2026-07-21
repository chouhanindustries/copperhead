import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  run(input: string, options?: { outputSchema?: Record<string, unknown> }): Promise<CodexTurnLike>;
}

export interface CodexClientLike {
  startThread(options?: {
    model?: string;
    workingDirectory?: string;
    skipGitRepoCheck?: boolean;
    sandboxMode?: 'read-only';
    approvalPolicy?: 'never';
    networkAccessEnabled?: boolean;
    webSearchMode?: 'disabled';
  }): CodexThreadLike;
}

export interface CodexProviderOptions {
  /** Omit to use the model selected by the user's Codex configuration. */
  model?: string;
  /** Defaults to a unique temporary directory; this is not a read-confinement boundary. */
  workingDirectory?: string;
  /** Production injects the lazily loaded official Codex SDK; tests use a fake. */
  client: CodexClientLike;
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
  private workingDirectory: string | null;
  private readonly client: CodexClientLike;
  private thread: CodexThreadLike | null = null;
  private messageCursor = 0;

  constructor(options: CodexProviderOptions) {
    this.model = options.model;
    this.workingDirectory = options.workingDirectory ?? null;
    this.client = options.client;
  }

  async chat(messages: Msg[], tools: ToolSchema[], _opts: ChatOpts = {}): Promise<Turn> {
    const workingDirectory = await this.ensureWorkingDirectory();
    if (!this.thread) {
      this.thread = this.client.startThread({
        ...(this.model ? { model: this.model } : {}),
        workingDirectory,
        skipGitRepoCheck: true,
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        networkAccessEnabled: false,
        webSearchMode: 'disabled',
      });
    }

    const cursor = this.messageCursor;
    const schema = turnSchema(tools);
    const allowedTools = new Set(tools.map((tool) => tool.name));
    const attempts: CodexTurnLike[] = [];
    let result = await this.runThread(renderTurnPrompt(messages, cursor, tools), schema);
    attempts.push(result);

    let parsed: ReturnType<typeof parseStructuredTurn>;
    try {
      parsed = parseStructuredTurn(result.finalResponse, allowedTools);
    } catch (err) {
      const validationError = (err as Error).message;
      result = await this.runThread(renderCorrectionPrompt(messages, cursor, tools, validationError), schema);
      attempts.push(result);
      parsed = parseStructuredTurn(result.finalResponse, allowedTools);
    }

    // The input remains unseen until Copperhead accepts a structured turn.
    this.messageCursor = messages.length;
    return {
      text: parsed.text.trim() || null,
      toolCalls: parsed.toolCalls,
      usage: {
        inputTokens: attempts.reduce((sum, attempt) => sum + (attempt.usage?.input_tokens ?? 0), 0),
        outputTokens: attempts.reduce((sum, attempt) => sum + (attempt.usage?.output_tokens ?? 0), 0),
      },
    };
  }

  private async ensureWorkingDirectory(): Promise<string> {
    if (this.workingDirectory) {
      await mkdir(this.workingDirectory, { recursive: true });
      return this.workingDirectory;
    }
    this.workingDirectory = await mkdtemp(path.join(tmpdir(), 'copperhead-codex-'));
    return this.workingDirectory;
  }

  private async runThread(prompt: string, outputSchema: Record<string, unknown>): Promise<CodexTurnLike> {
    try {
      return await this.thread!.run(prompt, { outputSchema });
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

function renderCorrectionPrompt(messages: Msg[], cursor: number, tools: ToolSchema[], validationError: string): string {
  return [
    'Copperhead rejected your previous structured turn.',
    `<validation_error>\n${validationError}\n</validation_error>`,
    'Return one corrected replacement turn using only the current Copperhead tool catalog.',
    'The original Copperhead input is repeated below because it has not been accepted yet:',
    renderTurnPrompt(messages, cursor, tools),
  ].join('\n\n');
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
