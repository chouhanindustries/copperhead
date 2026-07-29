import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { RawLog, ConsoleMirror } from '../src/agent/rawlog.js';
import { runAgentLoop } from '../src/agent/loop.js';
import type { ChatOpts, Msg, Provider, ToolSchema, Turn } from '../src/agent/types.js';
import { setColorEnabled } from '../src/agent/theme.js';
import { tempFixtureRepo } from './helpers.js';

/**
 * What a run leaves behind besides its structured transcript: the verbatim
 * provider traffic (`raw.log`) and a plain-text mirror of everything it printed
 * (`console.log`), both written as the run happens rather than at the end.
 */

async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ch-rawlog-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe('RawLog', () => {
  it('writes one JSON object per entry, attributed to the provider', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const log = new RawLog(dir);
      const sink = log.sink('openai');
      sink({ kind: 'request', data: { model: 'gpt-5' } });
      sink({ kind: 'response', data: { choices: [] } });
      await log.flush();

      const lines = (await readFile(log.path, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      expect(lines).toHaveLength(2);
      expect(lines[0].kind).toBe('request');
      expect(lines[0].provider).toBe('openai');
      expect(lines[0].data).toEqual({ model: 'gpt-5' });
      expect(typeof lines[0].ts).toBe('string');
    } finally {
      await cleanup();
    }
  });

  it('redacts secrets at write time, like every other run artifact (AC-4.1)', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const log = new RawLog(dir);
      log.write({ kind: 'request', data: { authorization: 'Bearer sk-abcdefghijklmnopqrstuvwxyz012345' } });
      await log.flush();
      const text = await readFile(log.path, 'utf8');
      expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    } finally {
      await cleanup();
    }
  });

  it('survives a payload it cannot serialize instead of failing the turn', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      const log = new RawLog(dir);
      log.write({ kind: 'response', data: cyclic });
      await log.flush();
      expect(JSON.parse((await readFile(log.path, 'utf8')).trim()).data).toBe('[unserializable]');
    } finally {
      await cleanup();
    }
  });

  it('truncates a single huge payload rather than writing it whole', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const log = new RawLog(dir);
      log.write({ kind: 'request', data: 'x'.repeat(2_000_000) });
      await log.flush();
      const text = await readFile(log.path, 'utf8');
      expect(text).toContain('[truncated]');
      expect(text.length).toBeLessThan(1_000_000);
    } finally {
      await cleanup();
    }
  });
});

describe('ConsoleMirror', () => {
  it('mirrors lines without ANSI so the file reads plainly', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const mirror = new ConsoleMirror(dir);
      mirror.write('\x1b[36mstage schematic\x1b[0m: running');
      await mirror.flush();
      expect(await readFile(mirror.path, 'utf8')).toBe('stage schematic: running\n');
    } finally {
      await cleanup();
    }
  });
});

/** Plays one scripted turn, records what the loop handed it, then finishes. */
function streamingProvider(text: string): Provider & { seenOpts: ChatOpts[] } {
  const seenOpts: ChatOpts[] = [];
  let turn = 0;
  return {
    name: 'scripted',
    seenOpts,
    async chat(_messages: Msg[], _tools: ToolSchema[], opts: ChatOpts = {}): Promise<Turn> {
      seenOpts.push(opts);
      opts.raw?.({ kind: 'request', data: { turn: ++turn } });
      for (const chunk of text.match(/.{1,4}/gs) ?? []) opts.onText?.(chunk);
      opts.raw?.({ kind: 'response', data: { text } });
      return {
        text,
        toolCalls: [
          {
            id: `call-${turn}`,
            name: 'finish',
            args: { outcome: 'refuse', summary: 'nothing to do (test)' },
          },
        ],
        usage: { inputTokens: 5, outputTokens: 2 },
      };
    },
  };
}

describe('a run records its traffic and its output', () => {
  it('writes raw.log and console.log beside the transcript, and prints streamed text once', async () => {
    setColorEnabled(false);
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const printed: string[] = [];
      const provider = streamingProvider('first line\nsecond line');
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'noop',
        model: 'gpt-5',
        provider,
        log: (l) => printed.push(l),
      });

      // The loop hands the provider both a text sink and a raw sink.
      expect(provider.seenOpts[0]!.onText).toBeTypeOf('function');
      expect(provider.seenOpts[0]!.raw).toBeTypeOf('function');

      const rawPath = path.join(res.transcriptDir, 'raw.log');
      const consolePath = path.join(res.transcriptDir, 'console.log');
      expect(existsSync(rawPath)).toBe(true);
      expect(existsSync(consolePath)).toBe(true);

      const raw = (await readFile(rawPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      expect(raw.map((e) => e.kind)).toEqual(['request', 'response']);
      expect(raw.every((e) => e.provider === 'scripted')).toBe(true);

      // Streamed text is printed as it arrives and NOT again when the turn
      // lands: a doubled turn is the obvious failure of this design.
      const output = printed.join('\n');
      expect(output.match(/first line/g)).toHaveLength(1);
      expect(output.match(/second line/g)).toHaveLength(1);

      // Everything printed is in the mirror, plain text.
      const mirrored = await readFile(consolePath, 'utf8');
      expect(mirrored).toContain('first line');
      expect(mirrored).toContain('second line');
      expect(mirrored).not.toMatch(/\x1b\[/);
    } finally {
      await cleanup();
    }
  });

  it('a provider that does not stream still gets its turn printed exactly once', async () => {
    setColorEnabled(false);
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const printed: string[] = [];
      const silent: Provider = {
        name: 'silent',
        async chat(): Promise<Turn> {
          return {
            text: 'one shot answer',
            toolCalls: [{ id: 'c1', name: 'finish', args: { outcome: 'refuse', summary: 'done (test)' } }],
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      };
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'noop',
        model: 'gpt-5',
        provider: silent,
        log: (l) => printed.push(l),
      });
      expect(printed.join('\n').match(/one shot answer/g)).toHaveLength(1);
      // The run dir still gets both files; raw.log is simply empty for a
      // provider that reports nothing.
      const entries = await readdir(res.transcriptDir);
      expect(entries).toContain('console.log');
    } finally {
      await cleanup();
    }
  });
});
