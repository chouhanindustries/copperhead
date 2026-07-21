import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import type { Msg, Provider, Turn } from './types.js';
import { availableTools, dispatchTool, type RunContext } from './tools.js';
import { buildSystemPrompt } from './prompts.js';
import { loadConstraints, reopenDeferredAffects } from '../memory/constraints.js';
import { loadConfig, type CopperheadConfig } from '../config.js';
import { Transcript } from './transcript.js';
import { ObligationsLedger } from './ledger.js';
import { gitPreflight, isDirty, snapshot, restore, commitAll, changedFiles } from '../util/git.js';
import { withRetry, isRateLimit } from '../util/retry.js';
import { openspecArchive } from '../openspec/cli.js';
import { existsSync } from 'node:fs';
import { OpenAIProvider } from './providers/openai.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { openSynapMemory, type RunRecord, type SynapMemory } from '../memory/synap.js';

export interface RunOptions {
  repoRoot: string;
  request: string;
  model: string;
  maxTurns?: number;
  allowDirty?: boolean;
  dryRun?: boolean;
  interactive?: boolean;
  confirm?: (q: string) => Promise<boolean>;
  /** Extra prompt appended for pipeline stages (Mode A). */
  stagePrompt?: string;
  log?: (line: string) => void;
}

export interface RunResult {
  outcome: 'success' | 'refused' | 'failure';
  summary: string;
  transcriptDir: string;
  filesTouched: string[];
  commit: string | null;
}

export function makeProvider(model: string): Provider {
  if (model === 'claude' || model.startsWith('claude')) {
    return new AnthropicProvider(model === 'claude' ? undefined : model);
  }
  return new OpenAIProvider(model === 'gpt-5' ? undefined : model);
}

function otherProvider(current: Provider): Provider | null {
  if (current.name === 'openai' && process.env.ANTHROPIC_API_KEY) return new AnthropicProvider();
  if (current.name === 'anthropic' && process.env.OPENAI_API_KEY) return new OpenAIProvider();
  return null;
}

async function appendChangelog(
  repoRoot: string,
  config: CopperheadConfig,
  entry: { changeId: string | null; request: string; files: string[]; verification: string },
): Promise<void> {
  const p = path.join(repoRoot, config.docs, 'CHANGELOG.md');
  const date = new Date().toISOString().slice(0, 10);
  const block = [
    ``,
    `## ${date} — ${entry.request}`,
    ``,
    `- Change: ${entry.changeId ?? 'n/a'}`,
    `- Files: ${entry.files.join(', ') || '(none)'}`,
    `- Verification: ${entry.verification}`,
  ].join('\n');
  let text: string;
  try {
    text = await readFile(p, 'utf8');
  } catch {
    text = '# Design changelog\n\nAppend-only, newest first. One entry per committed copperhead run.\n';
  }
  // newest first: insert right after the header block (first blank line after content start)
  const lines = text.split('\n');
  let insertAt = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('## ')) {
      insertAt = i;
      break;
    }
  }
  lines.splice(insertAt, 0, ...block.split('\n').slice(1), '');
  await writeFile(p, lines.join('\n'), 'utf8');
}

/**
 * Owns the Synap session for one run. The bridge is a subprocess, so the
 * shutdown in `finally` is what lets the CLI exit; without it the process
 * hangs after a successful run.
 */
export async function runAgentLoop(opts: RunOptions): Promise<RunResult> {
  const memory = await openSynapMemory({ repoRoot: opts.repoRoot, log: opts.log });
  try {
    return await runWithMemory(opts, memory);
  } finally {
    await memory?.close();
  }
}

async function runWithMemory(opts: RunOptions, memory: SynapMemory | null): Promise<RunResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const repoRoot = opts.repoRoot;
  const config = await loadConfig(repoRoot);
  const maxTurns = opts.maxTurns ?? config.maxTurns;

  await gitPreflight(repoRoot, { allowDirty: opts.allowDirty ?? false });
  const snap = await snapshot(repoRoot);

  const transcript = new Transcript(repoRoot);
  await transcript.init();
  const ctx: RunContext = {
    repoRoot,
    config,
    transcript,
    ledger: new ObligationsLedger(),
    runId: path.basename(transcript.dir),
    interactive: opts.interactive ?? false,
    confirm: opts.confirm ?? (async () => true),
    editsUnlocked: false,
    changeId: null,
    proposalValidated: false,
    filesTouched: new Set(),
    decisions: [],
    lastErc: null,
    lastDrc: null,
    repairCycles: 0,
    finishRequest: null,
  };

  let provider = makeProvider(opts.model);
  // Revisit obligations deferred while their artifact didn't exist re-open now
  // if it does (must run before loadConstraints so the prompt sees the updated
  // registry). They land in this run's fresh ledger, so finish gates on them.
  const reopened = await reopenDeferredAffects(repoRoot, config, (key, item) =>
    ctx.ledger.add('affects-revisit', `${key} affects ${item}`, key),
  );
  if (reopened.length) {
    await transcript.event('deferred-affects-reopened', { reopened });
    log(`re-opened ${reopened.length} deferred constraint revisit obligation(s)`);
  }
  const constraints = await loadConstraints(repoRoot);
  let basePrompt = await buildSystemPrompt(repoRoot, config, constraints);
  if (reopened.length) {
    basePrompt += [
      '',
      '',
      '## Reopened constraint revisits',
      '',
      'These constraints were recorded before their target artifact existed; the artifact now exists.',
      'Revisit each against the design and close it with resolve_affected (batch the calls):',
      ...reopened.map((r) => `- ${r.key} affects ${r.item}`),
    ].join('\n');
  }
  // Cross-run memory is appended after the repo's own docs and constraints so
  // that the in-repo sources of truth are what the model reads first.
  const recalled = memory ? await memory.recall(opts.request) : null;
  if (recalled) {
    await transcript.event('synap-recall', { chars: recalled.length });
    log('recalled prior context from Synap memory');
  }
  const system = recalled ? `${basePrompt}\n\n${recalled}` : basePrompt;
  const messages: Msg[] = [
    { role: 'system', content: system },
    { role: 'user', content: opts.stagePrompt ? `${opts.stagePrompt}\n\nRequest: ${opts.request}` : opts.request },
  ];
  await transcript.event('run-start', { request: opts.request, model: opts.model, provider: provider.name });

  /**
   * A memory write that fails is reported rather than swallowed, but it does
   * not change the run's outcome: discarding a verified commit because a
   * third-party write failed would be the worse trade.
   */
  const remember = async (run: RunRecord): Promise<void> => {
    if (!memory) return;
    try {
      await memory.record(run);
      await transcript.event('synap-record', { outcome: run.outcome });
    } catch (err) {
      const message = (err as Error).message;
      log(`warning: Synap memory write failed (${message}); this run was not recorded`);
      await transcript.event('synap-record-failed', { error: message });
    }
  };

  let tokensIn = 0;
  let tokensOut = 0;
  let plan: string | null = null;
  let nudges = 0;

  const fail = async (reason: string): Promise<RunResult> => {
    await transcript.event('run-failed', { reason });
    await restore(repoRoot, snap);
    const summaryPath = await transcript.writeSummary({
      request: opts.request,
      changeId: ctx.changeId,
      plan,
      filesTouched: [...ctx.filesTouched],
      ercResult: ctx.lastErc ? (ctx.lastErc.ok ? 'clean' : `${ctx.lastErc.violations.length} violations`) : null,
      drcResult: ctx.lastDrc ? (ctx.lastDrc.ok ? 'clean' : `${ctx.lastDrc.violations.length} violations`) : null,
      decisions: ctx.decisions,
      tokensIn,
      tokensOut,
      outcome: 'failure',
      openObligations: ctx.ledger.isClear ? null : ctx.ledger.describe(),
      detail: reason,
    });
    log(`run failed: ${reason}`);
    log(`working tree restored to pre-run snapshot`);
    log(`transcript: ${transcript.jsonlPath}`);
    log(`summary: ${summaryPath}`);
    return {
      outcome: 'failure',
      summary: reason,
      transcriptDir: transcript.dir,
      filesTouched: [],
      commit: null,
    };
  };

  for (let turn = 0; turn < maxTurns; turn++) {
    const tools = availableTools(ctx).map((t) => t.schema);
    let res: Turn;
    try {
      res = await withRetry(() => provider.chat(messages, tools), {
        onRetry: (attempt) => log(`rate limited; retry ${attempt}`),
      });
    } catch (err) {
      if (isRateLimit(err)) {
        const fallback = otherProvider(provider);
        if (fallback) {
          log(`failing over ${provider.name} → ${fallback.name}`);
          await transcript.event('provider-failover', { from: provider.name, to: fallback.name });
          provider = fallback;
          turn--;
          continue;
        }
      }
      return fail(`provider error: ${(err as Error).message}`);
    }
    tokensIn += res.usage.inputTokens;
    tokensOut += res.usage.outputTokens;
    await transcript.event('assistant', { text: res.text, toolCalls: res.toolCalls });

    if (res.text) {
      if (!plan) plan = res.text;
      log(res.text);
    }
    messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });

    if (!res.toolCalls.length) {
      if (nudges++ >= 2) return fail('model stopped calling tools without finishing');
      messages.push({
        role: 'user',
        content: 'Continue using tools, or call finish({outcome, summary}) to end the run.',
      });
      continue;
    }

    for (const call of res.toolCalls) {
      const result = await dispatchTool(ctx, call.name, call.args);
      await transcript.event('tool', { name: call.name, args: call.args, result });
      log(`  [${call.name}] ${result.split('\n')[0]}`);
      messages.push({ role: 'tool', toolCallId: call.id, content: result });
    }

    if (ctx.repairCycles > config.maxRepairCycles) {
      return fail(`repair cycles exhausted (${config.maxRepairCycles}); violations persist`);
    }

    const remaining = maxTurns - turn - 1;
    if (remaining === 5 && !ctx.finishRequest) {
      messages.push({
        role: 'user',
        content:
          'Only 5 turns remain. Converge now: finish the minimal correct edit set, run run_erc (and run_drc if the board changed), run check_drift, then call finish.',
      });
    }

    if (ctx.finishRequest) {
      const { outcome, summary } = ctx.finishRequest;
      const files = [...ctx.filesTouched];
      if (outcome === 'refuse') {
        await restore(repoRoot, snap);
        await transcript.event('run-refused', { summary });
        await transcript.writeSummary({
          request: opts.request,
          changeId: ctx.changeId,
          plan,
          filesTouched: [],
          ercResult: null,
          drcResult: null,
          decisions: ctx.decisions,
          tokensIn,
          tokensOut,
          outcome: 'aborted',
          openObligations: null,
          detail: `REFUSED: ${summary}`,
        });
        // Refusals are the most valuable thing to remember: they encode a budget
        // or constraint that this user's designs keep running into.
        await remember({
          request: opts.request,
          outcome: 'refused',
          summary,
          changeId: ctx.changeId,
          filesTouched: [],
          decisions: ctx.decisions,
          verification: 'n/a (refused before verification)',
        });
        log(`refused: ${summary}`);
        return { outcome: 'refused', summary, transcriptDir: transcript.dir, filesTouched: [], commit: null };
      }

      const verification = [
        ctx.lastErc ? `ERC ${ctx.lastErc.ok ? 'clean' : 'FAILING'}` : 'ERC not required',
        ctx.lastDrc ? `DRC ${ctx.lastDrc.ok ? 'clean' : 'FAILING'}` : null,
      ]
        .filter(Boolean)
        .join(', ');

      if (opts.dryRun) {
        const { stdout: diff } = await execa('git', ['diff'], { cwd: repoRoot });
        const { stdout: untracked } = await execa('git', ['ls-files', '--others', '--exclude-standard'], {
          cwd: repoRoot,
        });
        log('--- dry run: proposed diff ---');
        log(diff || '(no diff)');
        if (untracked) log(`new files:\n${untracked}`);
        await restore(repoRoot, snap);
        await transcript.writeSummary({
          request: opts.request,
          changeId: ctx.changeId,
          plan,
          filesTouched: files,
          ercResult: verification,
          drcResult: null,
          decisions: ctx.decisions,
          tokensIn,
          tokensOut,
          outcome: 'success',
          openObligations: null,
          detail: 'dry run: changes reverted',
        });
        return { outcome: 'success', summary, transcriptDir: transcript.dir, filesTouched: files, commit: null };
      }

      await appendChangelog(repoRoot, config, {
        changeId: ctx.changeId,
        request: opts.request,
        files,
        verification,
      });
      ctx.ledger.clear('changelog');

      const commitMsg = `copperhead: ${opts.request}\n\n${summary}\n\nVerification: ${verification}`;
      const commit = await commitAll(repoRoot, commitMsg);
      if (ctx.changeId && existsSync(path.join(repoRoot, 'openspec', 'config.yaml'))) {
        const arch = await openspecArchive(repoRoot, ctx.changeId);
        await transcript.event('openspec-archive', { changeId: ctx.changeId, ok: arch.ok });
        if (arch.ok && (await isDirty(repoRoot))) {
          await commitAll(repoRoot, `copperhead: archive change ${ctx.changeId}`);
        }
      }
      await transcript.event('run-committed', { commit, files });
      await transcript.writeSummary({
        request: opts.request,
        changeId: ctx.changeId,
        plan,
        filesTouched: files,
        ercResult: ctx.lastErc ? (ctx.lastErc.ok ? 'clean' : 'FAILING') : 'not run',
        drcResult: ctx.lastDrc ? (ctx.lastDrc.ok ? 'clean' : 'FAILING') : 'not run',
        decisions: ctx.decisions,
        tokensIn,
        tokensOut,
        outcome: 'success',
        openObligations: null,
      });
      await remember({
        request: opts.request,
        outcome: 'success',
        summary,
        changeId: ctx.changeId,
        filesTouched: files,
        decisions: ctx.decisions,
        verification,
      });
      log(`committed ${commit.slice(0, 10)} (${files.length} file(s))`);
      return { outcome: 'success', summary, transcriptDir: transcript.dir, filesTouched: files, commit };
    }
  }

  const filesAfter = await changedFiles(repoRoot, snap.head);
  return fail(`turn budget exhausted (${maxTurns} turns, ${filesAfter.length} files touched but unverified)`);
}
