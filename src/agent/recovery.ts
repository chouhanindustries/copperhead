import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Msg, Provider } from './types.js';

/** Thrown when a single provider turn blows past its watchdog deadline. */
export class TurnTimeoutError extends Error {
  constructor(public readonly ms: number) {
    super(`turn exceeded ${ms}ms without responding`);
    this.name = 'TurnTimeoutError';
  }
}

/**
 * Race `fn()` against a deadline so a hung provider call cannot stall the run
 * forever. On timeout, `onTimeout` runs (tear down the in-flight call, e.g.
 * provider.close()) and the returned promise rejects with TurnTimeoutError; the
 * caller decides whether to retry or fail. `ms <= 0` (or non-finite) disables the
 * watchdog and just awaits `fn()`.
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  ms: number,
  onTimeout?: () => void | Promise<void>,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return fn();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void Promise.resolve(onTimeout?.()).catch(() => {});
      reject(new TurnTimeoutError(ms));
    }, ms);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface StageDiagnosis {
  verdict: 'retry' | 'abort';
  reason: string;
  /** When retrying: concrete instructions to prepend to the next attempt. */
  guidance?: string;
  /** Tokens the diagnosis call itself spent, so the pipeline can fold them into
   *  the stage's cost total (F6). Absent when the call threw before a response. */
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Scans brace-balanced JSON candidates in text to locate a StageDiagnosis payload
 * with a recognized verdict ('retry' or 'abort'). If a valid JSON candidate lacks a
 * recognized verdict, its reason is retained as a fallback while scanning continues.
 * Anything unparseable or ambiguous defaults to "abort" so the pipeline never loops.
 */
export function parseDiagnosis(text: string | null): StageDiagnosis {
  if (!text) return { verdict: 'abort', reason: 'no diagnosis produced' };

  let fallbackReason: string | undefined;

  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{') continue;

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
      else if (ch === '}' && --depth === 0) {
        try {
          const candidate = text.slice(start, i + 1);
          const o = JSON.parse(candidate) as Partial<StageDiagnosis>;
          if (typeof o === 'object' && o !== null) {
            if (typeof o.reason === 'string' && o.reason.trim()) {
              fallbackReason = o.reason.trim();
            }
            if (o.verdict === 'retry' || o.verdict === 'abort') {
              const verdict = o.verdict === 'retry' ? 'retry' : 'abort';
              return {
                verdict,
                reason: typeof o.reason === 'string' && o.reason.trim() ? o.reason.trim() : 'no reason given',
                ...(verdict === 'retry' && typeof o.guidance === 'string' && o.guidance.trim()
                  ? { guidance: o.guidance.trim() }
                  : {}),
              };
            }
          }
        } catch {
          // Not valid JSON starting at this brace; break inner loop to try next candidate '{'
          break;
        }
      }
    }
  }

  return { verdict: 'abort', reason: fallbackReason ?? 'diagnosis was not valid JSON' };
}

/** Compact, most-recent-last excerpt of a run's transcript for the diagnostician:
 * the last assistant message and the last few tool results, truncated. */
export async function transcriptExcerpt(transcriptDir: string, maxChars = 4000): Promise<string> {
  const p = path.join(transcriptDir, 'transcript.jsonl');
  if (!existsSync(p)) return '(no transcript)';
  let lines: string[];
  try {
    lines = (await readFile(p, 'utf8')).trim().split('\n');
  } catch {
    return '(transcript unreadable)';
  }
  const parts: string[] = [];
  for (const line of lines.slice(-12)) {
    try {
      const e = JSON.parse(line) as { type: string; data?: Record<string, unknown> };
      if (e.type === 'assistant' && typeof e.data?.text === 'string' && e.data.text) {
        parts.push(`[assistant] ${e.data.text}`);
      } else if (e.type === 'tool') {
        parts.push(`[${String(e.data?.name)}] ${String(e.data?.result ?? '').split('\n')[0]}`);
      }
    } catch {
      /* skip */
    }
  }
  const joined = parts.join('\n');
  return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
}

/**
 * Ask the model whether a failed/incomplete stage is worth retrying, and if so
 * how. Uses a fresh, tool-less provider turn (the same saved-login backend the
 * pipeline runs on), so no extra credentials or config are needed. Any error or
 * ambiguity resolves to "abort" — recovery must fail safe toward reporting to the
 * human rather than looping.
 */
export async function diagnoseStageFailure(
  provider: Provider,
  input: {
    stageName: string;
    stageGoal: string;
    failure: string;
    excerpt: string;
    attempt: number;
    maxAttempts: number;
  },
): Promise<StageDiagnosis> {
  const system =
    'You are the recovery supervisor for an automated KiCad PCB-design pipeline. ' +
    'A stage just failed or ended without meeting its completion contract. Judge whether ' +
    'another automated attempt is likely to succeed, or whether a human should intervene. ' +
    'Be decisive and terse.';
  const user =
    `Stage: ${input.stageName}\n` +
    `Stage goal: ${input.stageGoal}\n` +
    `Failure: ${input.failure}\n` +
    `This was attempt ${input.attempt} of ${input.maxAttempts}.\n\n` +
    `Recent transcript (most recent last):\n${input.excerpt}\n\n` +
    'Reply with ONLY a JSON object, no prose:\n' +
    '{"verdict":"retry"|"abort","reason":"<one sentence>","guidance":"<if retry: concrete, specific instructions to prepend to the next attempt so it avoids this failure; otherwise empty>"}\n' +
    '- "retry" if the failure looks transient or fixable with clearer instructions (a dropped or locked tool call, an empty/no-op edit, a skipped step, a timeout, a formatting slip).\n' +
    '- "abort" if repeating the same attempt will not help and a human should look (missing inputs, a genuine dead-end, or the same failure already seen on a prior attempt).';
  const messages: Msg[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  try {
    const turn = await provider.chat(messages, []);
    return { ...parseDiagnosis(turn.text), usage: turn.usage };
  } catch (e) {
    return { verdict: 'abort', reason: `diagnosis call failed: ${(e as Error).message}` };
  }
}
