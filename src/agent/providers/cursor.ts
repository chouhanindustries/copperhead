import { mkdtemp, rm, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import type { ChatOpts, Msg, Provider, ToolSchema, Turn } from '../types.js';
import { parseToolCalls, renderConversation, renderDelta, renderToolProtocol } from './tool-protocol.js';

/**
 * Saved-login provider: drives the Cursor Agent CLI (`agent` / `cursor-agent`) with
 * `agent login` authentication. Reasoning-only: plan mode, sandbox, isolated
 * workspace, JSON tool protocol (see `add-cursor-cli-provider`).
 */

export interface CursorRunArgs {
  prompt: string;
  systemPrompt: string;
  workspace: string;
  model?: string;
  resume?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export interface CursorRunResult {
  text: string;
  sessionId?: string;
  usage: { inputTokens: number; outputTokens: number };
}

export type CursorRunLike = (args: CursorRunArgs) => Promise<CursorRunResult>;

const NATIVE_MUTATION_TYPES = new Set([
  'tool_call',
  'tool_use',
  'tool-call',
  'shell',
  'write',
  'edit',
  'apply_patch',
  'file_change',
  'mcp_tool',
]);

export class CursorProvider implements Provider {
  readonly name = 'cursor';
  private callSeq = 0;
  private cwdPromise?: Promise<string>;
  private sessionId?: string;
  private sentCount = 0;
  private readonly inFlight = new Set<AbortController>();

  constructor(
    private readonly model?: string,
    private readonly runFn: CursorRunLike = defaultCursorRun,
  ) {}

  async chat(messages: Msg[], tools: ToolSchema[], opts: ChatOpts = {}): Promise<Turn> {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const systemPrompt = [system, renderToolProtocol(tools)].filter(Boolean).join('\n\n');
    const resume = this.sessionId;
    const prompt = resume ? renderDelta(messages, this.sentCount) : renderConversation(messages);
    const catalog = new Set(tools.map((t) => t.name));
    const workspace = await this.ensureWorkspace();

    const aborter = new AbortController();
    this.inFlight.add(aborter);
    let inputTokens = 0;
    let outputTokens = 0;
    let text: string | null = null;
    try {
      const result = await this.runFn({
        prompt,
        systemPrompt,
        workspace,
        ...(this.model ? { model: this.model } : {}),
        ...(resume ? { resume } : {}),
        signal: aborter.signal,
        env: subprocessEnv(),
      });
      text = result.text;
      if (result.sessionId) this.sessionId = result.sessionId;
      inputTokens = result.usage.inputTokens;
      outputTokens = result.usage.outputTokens;
      opts.onStream?.(text.length);
    } catch (err) {
      if (isAuthError(err)) throw new Error(authHint((err as Error).message));
      throw enhanceCliError(err);
    } finally {
      this.inFlight.delete(aborter);
    }

    this.sentCount = messages.length;
    const parsed = parseToolCalls(text, () => `cur-${++this.callSeq}`, catalog);
    return {
      text: parsed.text,
      toolCalls: parsed.toolCalls,
      usage: { inputTokens, outputTokens },
      nudge: parsed.nudge,
    };
  }

  async close(): Promise<void> {
    for (const aborter of this.inFlight) {
      try {
        aborter.abort();
      } catch {
        // best effort
      }
    }
    this.inFlight.clear();
    const pending = this.cwdPromise;
    this.cwdPromise = undefined;
    if (!pending) return;
    try {
      await rm(await pending, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }

  private async ensureWorkspace(): Promise<string> {
    if (!this.cwdPromise) this.cwdPromise = mkdtemp(path.join(os.tmpdir(), 'copperhead-cursor-'));
    const cwd = await this.cwdPromise;
    const now = new Date();
    await utimes(cwd, now, now).catch(() => {});
    return cwd;
  }
}

/** Minimal env passed to the Cursor CLI subprocess (saved login via `agent login`). */
const CURSOR_SUBPROCESS_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TERM',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'SystemRoot',
  'ComSpec',
  'APPDATA',
  'LOCALAPPDATA',
] as const;

/** Build an allowlisted env for the Cursor Agent subprocess (no API keys or unrelated secrets). */
export function subprocessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CURSOR_SUBPROCESS_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Parse `--print --output-format json` stdout into assistant text and session id. */
export function parseCursorStdout(stdout: string): CursorRunResult {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  let text = '';
  let sessionId: string | undefined;

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    assertNoNativeMutation(obj);
    const type = typeof obj.type === 'string' ? obj.type.toLowerCase() : '';
    if (type === 'result') {
      if (typeof obj.result === 'string') text = obj.result;
      if (typeof obj.session_id === 'string') sessionId = obj.session_id;
      if (obj.is_error === true) {
        throw new Error(typeof obj.result === 'string' ? obj.result : 'Cursor Agent returned an error result');
      }
    }
  }

  if (!text && lines.length) {
    // Fallback: last parseable JSON line with a string result field
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]!) as Record<string, unknown>;
        if (typeof obj.result === 'string') {
          text = obj.result;
          if (typeof obj.session_id === 'string') sessionId = obj.session_id;
          break;
        }
      } catch {
        continue;
      }
    }
  }

  return { text, sessionId, usage: { inputTokens: 0, outputTokens: 0 } };
}

function assertNoNativeMutation(obj: Record<string, unknown>): void {
  const type = typeof obj.type === 'string' ? obj.type.toLowerCase() : '';
  if (NATIVE_MUTATION_TYPES.has(type)) {
    throw new Error(
      `cursor: Cursor Agent emitted native tool event "${obj.type}" — reasoning-only invariant violated. Refusing to continue.`,
    );
  }
  const subtype = typeof obj.subtype === 'string' ? obj.subtype.toLowerCase() : '';
  if (/tool|shell|write|edit|patch|mutation/.test(subtype) && type !== 'result') {
    throw new Error(
      `cursor: Cursor Agent output subtype "${obj.subtype}" suggests native execution — reasoning-only invariant violated.`,
    );
  }
}

/** Default subprocess runner: invokes `agent` (or `COPPERHEAD_CURSOR_PATH`) in plan mode. */
export async function defaultCursorRun(args: CursorRunArgs): Promise<CursorRunResult> {
  const bin = process.env.COPPERHEAD_CURSOR_PATH || 'agent';
  const fullPrompt = [args.systemPrompt, args.prompt].filter(Boolean).join('\n\n---\n\n');
  const cmdArgs = [
    '--print',
    '--output-format',
    'json',
    '--mode',
    'plan',
    '--trust',
    '--sandbox',
    'enabled',
    '--workspace',
    args.workspace,
  ];
  if (args.model) cmdArgs.push('--model', args.model);
  if (args.resume) cmdArgs.push('--resume', args.resume);
  cmdArgs.push(fullPrompt);

  const { stdout } = await execa(bin, cmdArgs, {
    env: args.env ?? subprocessEnv(),
    signal: args.signal,
    reject: true,
    maxBuffer: 50 * 1024 * 1024,
  });
  return parseCursorStdout(stdout);
}

function isAuthError(err: unknown): boolean {
  const status = (err as { status?: number; exitCode?: number })?.status
    ?? (err as { exitCode?: number })?.exitCode;
  if (typeof status === 'number') return status === 401 || status === 403;
  const m = ((err as Error)?.message ?? '').toLowerCase();
  return /unauthenticat|unauthoriz|not logged in|please log in|login required|agent login/.test(m);
}

function authHint(detail: string): string {
  return (
    'cursor is not authenticated: run `agent login` and verify with `agent status`. ' +
    `Set COPPERHEAD_CURSOR_PATH if the CLI is not on PATH (original error: ${detail})`
  );
}

function enhanceCliError(err: unknown): Error {
  const original = err as Error & { code?: string; exitCode?: number };
  if (original.code === 'ENOENT') {
    return new Error(
      'Cursor Agent CLI not found on PATH. Install Cursor Agent or set COPPERHEAD_CURSOR_PATH to the `agent` binary.',
      { cause: err },
    );
  }
  if (original.message?.includes('reasoning-only invariant')) return original;
  return new Error(`Cursor CLI provider failed: ${original.message}`, { cause: err });
}
