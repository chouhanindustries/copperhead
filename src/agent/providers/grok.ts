import { mkdtemp, rm, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import type { ChatOpts, Msg, Provider, ToolSchema, Turn } from '../types.js';
import { parseToolCalls, renderConversation, renderDelta, renderToolProtocol } from './tool-protocol.js';

/**
 * Saved-login provider: drives the Grok Agent CLI (`agent` / `grok-agent`) with
 * `agent login` authentication. Reasoning-only: plan mode, sandbox, isolated
 * workspace, JSON tool protocol (see `add-grok-cli-provider`).
 *
 * Session resume is opt-in and mutually exclusive with the response cache (same
 * rule as claude-code): the cache can replay turns a resumed CLI session never
 * saw, which desyncs history. `makeProvider` enables resume only when the cache
 * is off.
 */

export interface GrokRunArgs {
  prompt: string;
  systemPrompt: string;
  workspace: string;
  model?: string;
  resume?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export interface GrokRunResult {
  text: string;
  sessionId?: string;
  usage: { inputTokens: number; outputTokens: number };
}

export type GrokRunLike = (args: GrokRunArgs) => Promise<GrokRunResult>;

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

/** Subtype tokens that indicate native execution (whole-token match). */
const NATIVE_SUBTYPE_RE = /(^|_)(tool|shell|write|edit|patch|mutation)(_|$)/;

export class GrokProvider implements Provider {
  readonly name = 'grok';
  private callSeq = 0;
  private cwdPromise?: Promise<string>;
  private sessionId?: string;
  private sentCount = 0;
  private readonly inFlight = new Set<AbortController>();

  constructor(
    private readonly model?: string,
    private readonly runFn: GrokRunLike = defaultGrokRun,
    /**
     * Opt-in: resume one CLI session across turns and send only new messages.
     * OFF by default and mutually exclusive with the response cache — mixing
     * them desyncs the resumed session. `makeProvider` enables it only when
     * the cache is off.
     */
    private readonly sessionResume = false,
  ) {}

  async chat(messages: Msg[], tools: ToolSchema[], opts: ChatOpts = {}): Promise<Turn> {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const systemPrompt = [system, renderToolProtocol(tools)].filter(Boolean).join('\n\n');
    const resume = this.sessionResume ? this.sessionId : undefined;
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
      if (this.sessionResume && result.sessionId) this.sessionId = result.sessionId;
      inputTokens = result.usage.inputTokens;
      outputTokens = result.usage.outputTokens;
      opts.onStream?.(text.length);
    } catch (err) {
      if (isAuthError(err)) throw new Error(authHint((err as Error).message));
      throw enhanceCliError(err);
    } finally {
      this.inFlight.delete(aborter);
    }

    // Only advance the high-water mark when resume is on (same as claude-code).
    if (this.sessionResume) this.sentCount = messages.length;
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
    if (!this.cwdPromise) this.cwdPromise = mkdtemp(path.join(os.tmpdir(), 'copperhead-grok-'));
    const cwd = await this.cwdPromise;
    const now = new Date();
    await utimes(cwd, now, now).catch(() => {});
    return cwd;
  }
}

/** Minimal env passed to the Grok CLI subprocess (saved login via `agent login`). */
const GROK_SUBPROCESS_ENV_KEYS = [
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
  // Windows home / login-config location (`USERPROFILE\.grok\cli-config.json`)
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'SystemRoot',
  'ComSpec',
  'APPDATA',
  'LOCALAPPDATA',
] as const;

/** Build an allowlisted env for the Grok Agent subprocess (no API keys or unrelated secrets). */
export function subprocessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of GROK_SUBPROCESS_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Parse `--print --output-format json` stdout into assistant text and session id. */
export function parseGrokStdout(stdout: string): GrokRunResult {
  const trimmed = stdout.trim();
  let text = '';
  let sessionId: string | undefined;
  let sawResult = false;

  // Prefer a single pretty-printed JSON object (whole buffer) before NDJSON lines.
  if (trimmed) {
    try {
      const whole = JSON.parse(trimmed) as Record<string, unknown>;
      const extracted = extractResultFields(whole);
      if (extracted) {
        return {
          text: extracted.text,
          sessionId: extracted.sessionId,
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }
    } catch (err) {
      if (isGrokHardFail(err)) throw err;
      // fall through to line-based parse
    }
  }

  const lines = trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const extracted = extractResultFields(obj);
    if (extracted) {
      text = extracted.text;
      sessionId = extracted.sessionId ?? sessionId;
      sawResult = true;
    }
  }

  if (!sawResult && !text && lines.length) {
    // Fallback: last parseable JSON line with a string result field
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]!) as Record<string, unknown>;
        if (typeof obj.result === 'string') {
          assertNoNativeMutation(obj);
          text = obj.result;
          if (typeof obj.session_id === 'string') sessionId = obj.session_id;
          sawResult = true;
          break;
        }
      } catch (err) {
        if (isGrokHardFail(err)) throw err;
        continue;
      }
    }
  }

  if (!sawResult && trimmed) {
    throw new Error(
      `grok: could not parse Grok Agent output as JSON — raw stdout: ${trimmed.slice(0, 500)}`,
    );
  }

  // Official Grok JSON schema does not expose token usage; callers see zeros.
  return { text, sessionId, usage: { inputTokens: 0, outputTokens: 0 } };
}

function extractResultFields(
  obj: Record<string, unknown>,
): { text: string; sessionId?: string } | null {
  assertNoNativeMutation(obj);
  const type = typeof obj.type === 'string' ? obj.type.toLowerCase() : '';
  if (type === 'result' || typeof obj.result === 'string') {
    if (obj.is_error === true) {
      throw new Error(typeof obj.result === 'string' ? obj.result : 'Grok Agent returned an error result');
    }
    if (typeof obj.result === 'string') {
      return {
        text: obj.result,
        ...(typeof obj.session_id === 'string' ? { sessionId: obj.session_id } : {}),
      };
    }
  }
  return null;
}

function isGrokHardFail(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message.includes('reasoning-only invariant') ||
      err.message.includes('Grok Agent returned an error') ||
      err.message.startsWith('grok:'))
  );
}

function assertNoNativeMutation(obj: Record<string, unknown>): void {
  const type = typeof obj.type === 'string' ? obj.type.toLowerCase() : '';
  if (NATIVE_MUTATION_TYPES.has(type)) {
    throw new Error(
      `grok: Grok Agent emitted native tool event "${obj.type}" — reasoning-only invariant violated. Refusing to continue.`,
    );
  }
  const subtype = typeof obj.subtype === 'string' ? obj.subtype.toLowerCase() : '';
  if (subtype && NATIVE_SUBTYPE_RE.test(subtype) && type !== 'result') {
    throw new Error(
      `grok: Grok Agent output subtype "${obj.subtype}" (line type "${obj.type ?? ''}") suggests native execution — reasoning-only invariant violated.`,
    );
  }
}

/** Default subprocess runner: invokes `agent` (or `COPPERHEAD_GROK_PATH`) in plan mode. */
export async function defaultGrokRun(args: GrokRunArgs): Promise<GrokRunResult> {
  const bin = process.env.COPPERHEAD_GROK_PATH || 'grok';
  const fullPrompt = [args.systemPrompt, args.prompt].filter(Boolean).join('\n\n---\n\n');
  
  // Create a temporary file for the prompt to avoid stdin/argv limits.
  const promptFile = path.join(os.tmpdir(), `copperhead-grok-prompt-${Date.now()}.txt`);
  const fs = await import('node:fs/promises');
  await fs.writeFile(promptFile, fullPrompt);

  const cmdArgs = [
    '--output-format',
    'json',
    '--permission-mode',
    'plan',
    '--cwd',
    args.workspace,
    '--prompt-file',
    promptFile,
  ];
  if (args.model) cmdArgs.push('--model', args.model);
  if (args.resume) cmdArgs.push('--resume', args.resume);

  let stdout: string;
  try {
    const res = await execa(bin, cmdArgs, {
      env: args.env ?? subprocessEnv(),
      cancelSignal: args.signal,
      reject: true,
      maxBuffer: 50 * 1024 * 1024,
    });
    stdout = res.stdout;
  } finally {
    await fs.unlink(promptFile).catch(() => {});
  }
  return parseGrokStdout(stdout);
}

function isAuthError(err: unknown): boolean {
  // Subprocess failures use exitCode, not HTTP status. Only treat real HTTP
  // status fields as 401/403; otherwise match the CLI's auth message.
  const status =
    (err as { status?: number; statusCode?: number })?.status ??
    (err as { statusCode?: number })?.statusCode;
  if (status === 401 || status === 403) return true;
  const m = ((err as Error)?.message ?? '').toLowerCase();
  return /unauthenticat|unauthoriz|not logged in|please log in|login required|agent login/.test(m);
}

function authHint(detail: string): string {
  return (
    'grok is not authenticated: run `agent login` and verify with `agent status`. ' +
    `Set COPPERHEAD_GROK_PATH if the CLI is not on PATH (original error: ${detail})`
  );
}

function enhanceCliError(err: unknown): Error {
  const original = err as Error & { code?: string; exitCode?: number };
  if (original.code === 'ENOENT') {
    return new Error(
      'Grok Agent CLI not found on PATH. Install Grok Agent or set COPPERHEAD_GROK_PATH to the `agent` binary.',
      { cause: err },
    );
  }
  if (original.message?.includes('reasoning-only invariant')) return original;
  return new Error(`Grok CLI provider failed: ${original.message}`, { cause: err });
}
