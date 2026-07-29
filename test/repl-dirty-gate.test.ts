import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';

/**
 * The REPL used to hardcode `allowDirty: true`, and it is the default command,
 * so bare `copperhead` ran every turn past the preflight that exists to stop a
 * rollback from destroying uncommitted work. It must default to the same
 * refusal `do` does, and only relax when the user asks.
 */
const runAgentLoop = vi.hoisted(() =>
  vi.fn(async () => ({ outcome: 'success' as const })),
);

vi.mock('../src/agent/loop.js', () => ({ runAgentLoop }));

const { runRepl } = await import('../src/commands/repl.js');
const { plainRenderer } = await import('../src/agent/render.js');
const { setColorEnabled } = await import('../src/agent/theme.js');

/** Non-TTY streams take the seed path, which runs exactly one real turn. */
async function runSeeded(extra: Record<string, unknown> = {}): Promise<void> {
  await runRepl({
    repoRoot: '/tmp/repo',
    model: 'gpt-5',
    modelSource: 'flag',
    version: '0.7.0',
    kicadCliVersion: '9.0.0',
    renderer: plainRenderer(() => {}),
    input: new PassThrough(),
    output: new PassThrough(),
    log: () => {},
    seed: 'rename R1 to R10',
    ...extra,
  });
}

describe('REPL dirty-tree gate', () => {
  beforeEach(() => {
    setColorEnabled(false);
    runAgentLoop.mockClear();
  });

  it('refuses a dirty tree by default, exactly as `do` does', async () => {
    await runSeeded();
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
    const opts = runAgentLoop.mock.calls[0]![0] as { allowDirty?: boolean };
    expect(opts.allowDirty).toBe(false);
  });

  it('relaxes only when the caller opts in', async () => {
    await runSeeded({ allowDirty: true });
    const opts = runAgentLoop.mock.calls[0]![0] as { allowDirty?: boolean };
    expect(opts.allowDirty).toBe(true);
  });

  it('still routes the request through the normal gated loop', async () => {
    // Spec-gated in / verification-gated out both live inside runAgentLoop:
    // the REPL must not grow a side path around it.
    await runSeeded();
    const opts = runAgentLoop.mock.calls[0]![0] as {
      request: string;
      meta: { command: string };
    };
    expect(opts.request).toBe('rename R1 to R10');
    expect(opts.meta.command).toBe('repl');
  });
});
