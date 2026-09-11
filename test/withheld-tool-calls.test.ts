import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execa } from 'execa';
import { runAgentLoop } from '../src/agent/loop.js';
import type { Msg, Provider, ToolSchema, Turn } from '../src/agent/types.js';
import { parseToolCalls } from '../src/agent/providers/tool-protocol.js';
import { runInit } from '../src/memory/scaffold.js';
import { tempFixtureRepo } from './helpers.js';
import { dispatchTool, type RunContext } from '../src/agent/tools.js';
import { ObligationsLedger } from '../src/agent/ledger.js';
import { Transcript } from '../src/agent/transcript.js';
import { loadConfig } from '../src/config.js';

/**
 * Text-protocol test provider that simulates claude-code / cursor:
 * It receives text replies from a script, parses them using the REAL parseToolCalls
 * with the per-turn advertised catalog, and returns the resulting Turn (including withheld).
 */
function textProtocolProvider(rawReplies: string[]): Provider & { seen: Msg[][] } {
  let i = 0;
  let callSeq = 0;
  const seen: Msg[][] = [];
  return {
    name: 'claude-code',
    seen,
    async chat(messages: Msg[], tools: ToolSchema[]): Promise<Turn> {
      seen.push([...messages]);
      const reply = rawReplies[Math.min(i, rawReplies.length - 1)]!;
      i++;
      const catalog = new Set(tools.map((t) => t.name));
      const parsed = parseToolCalls(reply, () => `test-${++callSeq}`, catalog);
      return {
        text: parsed.text,
        toolCalls: parsed.toolCalls,
        withheld: parsed.withheld,
        usage: { inputTokens: 50, outputTokens: 50 },
        nudge: parsed.nudge,
      };
    },
  };
}

describe('Issue #296: Withheld tool calls and finish guard', () => {
  it('parseToolCalls populates withheld for off-catalog tools in mixed batch', () => {
    const catalog = new Set(['propose_change', 'validate_change', 'finish']);
    const reply = [
      '```json',
      JSON.stringify({
        tool: 'propose_change',
        args: { id: 'test-change', why: 'test', what_changes: 'test', tasks: 'test' },
      }),
      '```',
      '```json',
      JSON.stringify({
        tool: 'write_file',
        args: { path: 'docs/SPEC.md', content: '# Spec\n' },
      }),
      '```',
      '```json',
      JSON.stringify({
        tool: 'finish',
        args: { outcome: 'done', summary: 'done' },
      }),
      '```',
    ].join('\n\n');

    let seq = 0;
    const parsed = parseToolCalls(reply, () => `call-${++seq}`, catalog);

    expect(parsed.toolCalls.map((c) => c.name)).toEqual(['propose_change', 'finish']);
    expect(parsed.withheld.length).toBe(1);
    expect(parsed.withheld[0]!.name).toBe('write_file');
    expect(parsed.withheld[0]!.reason).toContain('not in this turn\'s tool catalog');
  });

  it('blocks finish when a batched reply contains withheld tool calls, surfaces feedback, and succeeds on next turn', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'initial'], { cwd: repo });

      // Turn 1: Model batches propose_change, validate_change, write_file, check_drift, finish.
      // At parse time, edits are locked (catalog does not include write_file).
      // Turn 2: Model sees write_file was withheld, and now edits are unlocked. Model runs write_file, check_drift, finish.
      const turn1 = [
        '```json',
        JSON.stringify({
          tool: 'propose_change',
          args: { id: 'add-spec', why: 'needed', what_changes: '- write spec', tasks: '- [ ] write spec' },
        }),
        '```',
        '```json',
        JSON.stringify({ tool: 'validate_change', args: {} }),
        '```',
        '```json',
        JSON.stringify({
          tool: 'write_file',
          args: { path: 'docs/EXTRA.md', content: '# Extra Documentation\n\nSome content.' },
        }),
        '```',
        '```json',
        JSON.stringify({ tool: 'check_drift', args: {} }),
        '```',
        '```json',
        JSON.stringify({
          tool: 'finish',
          args: { outcome: 'done', summary: 'all work complete' },
        }),
        '```',
      ].join('\n\n');

      const turn2 = [
        '```json',
        JSON.stringify({
          tool: 'write_file',
          args: { path: 'docs/EXTRA.md', content: '# Extra Documentation\n\nSome content.' },
        }),
        '```',
        '```json',
        JSON.stringify({ tool: 'check_drift', args: {} }),
        '```',
        '```json',
        JSON.stringify({
          tool: 'finish',
          args: { outcome: 'done', summary: 'all work complete on retry' },
        }),
        '```',
      ].join('\n\n');

      const provider = textProtocolProvider([turn1, turn2]);

      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'add extra documentation',
        model: 'claude-code',
        provider,
        maxTurns: 5,
        log: () => {},
      });

      expect(res.outcome).toBe('success');
      expect(res.exitPath).toBe('done');
      expect(res.filesTouched).toContain('docs/EXTRA.md');

      // The created file should exist and contain the expected content
      const extraContent = await readFile(path.join(repo, 'docs', 'EXTRA.md'), 'utf8');
      expect(extraContent).toBe('# Extra Documentation\n\nSome content.');

      // Check the messages seen by the provider in turn 2:
      // It should have received a user message explaining that write_file was withheld and finish was blocked
      const turn2Messages = provider.seen[1]!;
      const userMessages = turn2Messages.filter((m) => m.role === 'user');
      const lastUserMsg = userMessages[userMessages.length - 1]!;
      expect(lastUserMsg.content).toContain('withheld');
      expect(lastUserMsg.content).toContain('"write_file"');
      expect(lastUserMsg.content).toContain('Cannot finish yet');
    } finally {
      await cleanup();
    }
  });

  it('finishGuard rejects premature finish and continues loop', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'initial'], { cwd: repo });

      let guardChecked = 0;
      const provider = textProtocolProvider([
        // Turn 1: try to finish immediately
        '```json\n{"tool": "finish", "args": {"outcome": "done", "summary": "premature finish"}}\n```',
        // Turn 2: try to finish again after condition met
        '```json\n{"tool": "finish", "args": {"outcome": "done", "summary": "proper finish"}}\n```',
      ]);

      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'test guard',
        model: 'claude-code',
        provider,
        maxTurns: 3,
        log: () => {},
        finishGuard: async () => {
          guardChecked++;
          if (guardChecked === 1) {
            return 'stage requirement not met: missing SPEC.md';
          }
          return null;
        },
      });

      expect(guardChecked).toBe(2);
      expect(res.outcome).toBe('success');

      // Verify the model received the finish rejection feedback
      const turn2Messages = provider.seen[1]!;
      const userMessages = turn2Messages.filter((m) => m.role === 'user');
      const feedbackMsg = userMessages.find((m) => m.content.includes('Cannot finish yet: stage requirement not met'));
      expect(feedbackMsg).toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it('record_decision creates docs/ directory recursively if absent', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const transcript = new Transcript(repo);
      await transcript.init();
      const ctx: RunContext = {
        repoRoot: repo,
        config: { ...(await loadConfig(repo)), docs: 'nested/docs' },
        transcript,
        ledger: new ObligationsLedger(),
        runId: 'test-run',
        interactive: false,
        confirm: async () => true,
        editsUnlocked: true,
        changeId: 'test-change',
        proposalValidated: true,
        filesTouched: new Set(),
        decisions: [],
        lastErc: null,
        lastDrc: null,
        lastLegibility: null,
        lastScore: null,
        repairCycles: 0,
        finishRequest: null,
      };

      const res = await dispatchTool(ctx, 'record_decision', {
        decision: 'Use 3.3V LDO',
        rationale: 'lower noise',
        affects: 'power',
      });

      expect(res).toBe('decision recorded');
      expect(existsSync(path.join(repo, 'nested', 'docs', 'DECISIONS.md'))).toBe(true);
      const content = await readFile(path.join(repo, 'nested', 'docs', 'DECISIONS.md'), 'utf8');
      expect(content).toContain('Use 3.3V LDO');
    } finally {
      await cleanup();
    }
  });
});
