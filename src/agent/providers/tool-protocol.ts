import type { Msg, ToolCall, ToolSchema } from '../types.js';

export function renderToolProtocol(tools: ToolSchema[]): string {
  if (!tools.length) return '';
  const lines = [
    '# Tool protocol',
    '',
    'You are the reasoning half of a tool-driven workflow; you cannot run anything yourself.',
    'To take an action, reply with EXACTLY ONE JSON object and nothing else, wrapped in a',
    '```json fenced code block:',
    '',
    '```json',
    '{"tool": "<tool_name>", "args": { ... }}',
    '```',
    '',
    'Use only the tools listed below, with `args` matching the tool\'s JSON Schema. If you have',
    'no tool to call and only want to say something, reply with plain prose and no JSON block.',
    '',
    '## Available tools',
  ];
  for (const t of tools) {
    lines.push(
      '',
      `### ${t.name}`,
      t.description,
      `Parameters (JSON Schema): ${JSON.stringify(t.parameters)}`,
    );
  }
  return lines.join('\n');
}

/** Delta prompt for a resumed CLI session: new user lines and tool results only. */
export function renderDelta(messages: Msg[], from: number): string {
  const idToName = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'assistant') for (const call of m.toolCalls ?? []) idToName.set(call.id, call.name);
  }
  const parts: string[] = [];
  for (const m of messages.slice(Math.max(0, from))) {
    if (m.role === 'user') {
      parts.push(`[user]\n${m.content}`);
    } else if (m.role === 'tool') {
      const name = idToName.get(m.toolCallId) ?? m.toolCallId;
      parts.push(`[result of ${name}]\n${m.content}`);
    }
  }
  return parts.join('\n\n');
}

export function renderConversation(messages: Msg[]): string {
  const idToName = new Map<string, string>();
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      parts.push(`[user]\n${m.content}`);
    } else if (m.role === 'assistant') {
      if (m.content) parts.push(`[assistant]\n${m.content}`);
      for (const call of m.toolCalls ?? []) {
        idToName.set(call.id, call.name);
        parts.push(
          `[assistant tool call]\n\`\`\`json\n${JSON.stringify({ tool: call.name, args: call.args })}\n\`\`\``,
        );
      }
    } else {
      const name = idToName.get(m.toolCallId) ?? m.toolCallId;
      parts.push(`[result of ${name}]\n${m.content}`);
    }
  }
  return parts.join('\n\n');
}

export interface ParsedToolTurn {
  text: string | null;
  toolCalls: ToolCall[];
  nudge?: string;
}

function detectMalformedCall(text: string, catalog: Set<string>): string | undefined {
  const re = /"tool"\s*:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1]!;
    if (catalog.has(name)) {
      return (
        `A tool call for "${name}" looks malformed — it named the tool but did not parse as ` +
        'valid JSON (likely unbalanced braces or a missing closing brace), so no call ran. ' +
        'Re-emit it as exactly one complete JSON object: {"tool": "...", "args": { ... }}.'
      );
    }
  }
  return undefined;
}

export function parseToolCalls(
  text: string | null,
  nextId: () => string,
  catalog: Set<string>,
): ParsedToolTurn {
  if (!text) return { text: null, toolCalls: [] };
  const toolCalls: ToolCall[] = [];
  const matched: Array<[number, number]> = [];

  let searchFrom = 0;
  while (searchFrom < text.length) {
    const braceAt = text.indexOf('{', searchFrom);
    if (braceAt < 0) break;
    const span = scanJsonObject(text, braceAt);
    if (!span) {
      searchFrom = braceAt + 1;
      continue;
    }
    const call = toToolCall(text.slice(span.start, span.end), nextId, catalog);
    if (call) {
      toolCalls.push(call);
      matched.push([span.start, span.end]);
    }
    searchFrom = span.end;
  }

  if (!toolCalls.length) {
    return { text: text.trim() ? text : null, toolCalls, nudge: detectMalformedCall(text, catalog) };
  }

  let prose = '';
  let cursor = 0;
  for (const [start, end] of matched) {
    prose += text.slice(cursor, start);
    cursor = end;
  }
  prose += text.slice(cursor);
  prose = prose.replace(/```(?:json)?\s*```/gi, '').replace(/```(?:json)?\s*$/gi, '').trim();
  return { text: prose.length ? prose : null, toolCalls };
}

function scanJsonObject(text: string, from: number): { start: number; end: number } | null {
  const start = text.indexOf('{', from);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return { start, end: i + 1 };
  }
  return null;
}

function toToolCall(raw: string | undefined, nextId: () => string, catalog: Set<string>): ToolCall | null {
  if (!raw) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  if (typeof rec.tool !== 'string') return null;
  if (!catalog.has(rec.tool)) return null;
  const args = rec.args && typeof rec.args === 'object' ? (rec.args as Record<string, unknown>) : {};
  return { id: nextId(), name: rec.tool, args };
}
