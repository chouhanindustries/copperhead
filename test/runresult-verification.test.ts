import { describe, it, expect } from 'vitest';
import { runAgentLoop, type RunOptions } from '../src/agent/loop.js';
import type { Provider, Turn } from '../src/agent/types.js';
import { tempFixtureRepo } from './helpers.js';

/** Replays a fixed script of turns; the last one repeats forever. */
class ScriptedProvider implements Provider {
  readonly name = 'scripted';
  private i = 0;
  constructor(private readonly turns: Turn[]) {}
  async chat(): Promise<Turn> {
    const t = this.turns[Math.min(this.i, this.turns.length - 1)]!;
    this.i++;
    return t;
  }
}

const usage = { inputTokens: 10, outputTokens: 2 };

function opts(repo: string, provider: Provider, extra: Partial<RunOptions> = {}): RunOptions {
  return {
    repoRoot: repo,
    request: 'runresult verification test',
    model: 'gpt-5',
    provider,
    log: () => {},
    meta: { command: 'do', modelSource: 'flag', version: '9.9.9', kicadCliVersion: '9.0.0' },
    ...extra,
  };
}

describe('RunResult.verification (issue #40 groundwork)', () => {
  it('is present and null when a run fails before any ERC/DRC', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      // A turn that only calls an unavailable tool never runs a check; with a
      // one-turn budget the run exhausts and rolls back without verifying.
      const spin: Turn = { text: 'working', toolCalls: [{ id: 's', name: 'bogus', args: {} }], usage };
      const res = await runAgentLoop(opts(repo, new ScriptedProvider([spin]), { maxTurns: 1 }));
      expect(res.outcome).toBe('failure');
      expect(res).toHaveProperty('verification');
      expect(res.verification).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('is present and null on a refusal, which ends before verification', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const refuse: Turn = {
        text: null,
        toolCalls: [{ id: 'f', name: 'finish', args: { outcome: 'refuse', summary: 'not doing it' } }],
        usage,
      };
      const res = await runAgentLoop(opts(repo, new ScriptedProvider([refuse])));
      expect(res.outcome).toBe('refused');
      expect(res.verification).toBeNull();
    } finally {
      await cleanup();
    }
  });
});
