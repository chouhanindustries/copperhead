import { mkdtemp, cp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

export const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'open-key');
export const REPORTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'reports');

/**
 * Render a chat completion as the SSE stream the OpenAI SDK's streaming helper
 * expects, so a stub server can answer a streamed request with the same
 * fixtures the non-streamed tests use. Deliberately minimal: one delta per
 * choice, then a finish chunk, then the usage-only chunk that
 * `stream_options.include_usage` produces.
 */
export function chatCompletionSse(completion: Record<string, any>): string {
  const head = {
    id: completion.id ?? 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: completion.created ?? 1,
    model: completion.model ?? 'gpt-5',
  };
  const chunks: string[] = [];
  const push = (o: unknown): void => void chunks.push(`data: ${JSON.stringify(o)}\n\n`);
  for (const [i, choice] of (completion.choices ?? []).entries()) {
    const message = choice.message ?? {};
    const delta: Record<string, unknown> = { role: message.role ?? 'assistant' };
    if (message.content) delta.content = message.content;
    if (message.tool_calls?.length) {
      delta.tool_calls = message.tool_calls.map((c: Record<string, unknown>, index: number) => ({ index, ...c }));
    }
    const index = choice.index ?? i;
    push({ ...head, choices: [{ index, delta, finish_reason: null }] });
    push({ ...head, choices: [{ index, delta: {}, finish_reason: choice.finish_reason ?? 'stop' }] });
  }
  if (completion.usage) push({ ...head, choices: [], usage: completion.usage });
  chunks.push('data: [DONE]\n\n');
  return chunks.join('');
}

/** Copy the open-key fixture into a fresh temp dir and git-init it. */
export async function tempFixtureRepo(): Promise<{ repo: string; cleanup: () => Promise<void> }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-test-'));
  await cp(FIXTURE, repo, { recursive: true });
  // the target-repo convention (AC-4.3): .env and the run audit trail ignored
  await writeFile(path.join(repo, '.gitignore'), '.env\n.copperhead/runs/\n', 'utf8');
  await execa('git', ['init', '-q'], { cwd: repo });
  await execa('git', ['config', 'user.email', 'test@copperhead.local'], { cwd: repo });
  await execa('git', ['config', 'user.name', 'copperhead-test'], { cwd: repo });
  await execa('git', ['add', '-A'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', 'fixture'], { cwd: repo });
  return { repo, cleanup: () => rm(repo, { recursive: true, force: true }) };
}
