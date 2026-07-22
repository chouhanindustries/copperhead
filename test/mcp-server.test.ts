import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createCopperheadMcpServer, MCP_TOOL_NAMES, type McpDeps } from '../src/mcp/server.js';
import type { RunResult } from '../src/agent/loop.js';
import type { CheckResult } from '../src/commands/check.js';
import type { SyncReport } from '../src/commands/sync.js';
import type { CopperheadConfig } from '../src/config.js';

const REPO = '/tmp/copperhead-mcp-test-repo';

const config: CopperheadConfig = {
  schematic: null,
  board: null,
  docs: 'docs/',
  model: null,
  maxTurns: 40,
  maxRepairCycles: 5,
  budgets: {},
};

const okModel = () => ({ model: 'test-model', source: 'flag' as const });

function runResult(outcome: RunResult['outcome'], commit: string | null): RunResult {
  return {
    outcome,
    exitPath: outcome === 'success' ? 'done' : outcome === 'refused' ? 'refused' : 'repair-cycles-exhausted',
    summary: 'summary text',
    transcriptDir: '/tmp/run/xyz',
    filesTouched: ['docs/BOM.md'],
    commit,
    verification: outcome === 'failure' ? 'ERC FAILING' : 'ERC clean, DRC clean',
  };
}

async function connect(server: Server): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-host', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function callJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]!.text;
  return JSON.parse(text);
}

async function withServer(
  deps: Partial<McpDeps>,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const { client, close } = await connect(createCopperheadMcpServer(REPO, deps));
  try {
    await fn(client);
  } finally {
    await close();
  }
}

describe('MCP server surface (mcp-server spec)', () => {
  it('exposes exactly the four opaque tools and nothing that edits files directly', async () => {
    await withServer({}, async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'copperhead_check',
        'copperhead_do',
        'copperhead_init',
        'copperhead_sync',
      ]);
      expect(MCP_TOOL_NAMES.sort()).toEqual(tools.map((t) => t.name).sort());
      for (const t of tools) {
        expect((t.inputSchema as { type: string }).type).toBe('object');
        // no file-edit / raw-KiCad / partial-loop tool is reachable
        expect(t.name).not.toMatch(/edit|write|raw|read_file|erc|drc|footprint|patch/i);
      }
    });
  });
});

describe('copperhead_check', () => {
  it('returns the runCheck report verbatim (parity with check --json)', async () => {
    const report: CheckResult = {
      ok: true,
      erc: { ok: true, violations: 0 },
      drc: null,
      drift: { ok: true, mismatches: [] },
      openspec: null,
      constraints: { ok: true, violations: [] },
    };
    await withServer({ runCheck: async () => report }, async (client) => {
      expect(await callJson(client, 'copperhead_check')).toEqual(report);
    });
  });

  it('works with no API key present', async () => {
    const report: CheckResult = {
      ok: false,
      erc: { ok: false, violations: 2 },
      drc: null,
      drift: { ok: true, mismatches: [] },
      openspec: null,
      constraints: { ok: true, violations: [] },
    };
    // resolveModel would throw (no key) but check must never call it
    await withServer(
      {
        runCheck: async () => report,
        resolveModel: () => {
          throw new Error('should not be called');
        },
      },
      async (client) => {
        expect((await callJson(client, 'copperhead_check')).ok).toBe(false);
      },
    );
  });
});

describe('copperhead_do result mapping (design D6: outcomes are results)', () => {
  it.each([
    ['success-commit', runResult('success', 'abc1234'), 'committed'],
    ['failure', runResult('failure', null), 'rolled_back'],
    ['refused', runResult('refused', null), 'refused'],
  ])('maps %s to status %s with transcript and verification', async (_label, res, status) => {
    await withServer(
      { loadConfig: async () => config, resolveModel: okModel, runAgentLoop: async () => res },
      async (client) => {
        const out = await callJson(client, 'copperhead_do', { request: 'do a thing' });
        expect(out.status).toBe(status);
        expect(out.commit).toBe(res.commit);
        expect(out.transcript).toBe(res.transcriptDir);
        expect(out.verification).toBe(res.verification);
      },
    );
  });

  it('rollback is a successful tool call, not a protocol error', async () => {
    await withServer(
      { loadConfig: async () => config, resolveModel: okModel, runAgentLoop: async () => runResult('failure', null) },
      async (client) => {
        // callTool resolves (no throw); the result carries the rolled_back status
        const out = await callJson(client, 'copperhead_do', { request: 'break it' });
        expect(out.status).toBe('rolled_back');
      },
    );
  });

  it('dry run maps to a dry_run status without a commit', async () => {
    await withServer(
      { loadConfig: async () => config, resolveModel: okModel, runAgentLoop: async () => runResult('success', null) },
      async (client) => {
        const out = await callJson(client, 'copperhead_do', { request: 'propose only', dry_run: true });
        expect(out.status).toBe('dry_run');
        expect(out.commit).toBeNull();
      },
    );
  });
});

describe('progress notifications (design D5: long runs do not time out)', () => {
  it('copperhead_do forwards each loop log line to the host as a progress notification', async () => {
    // The injected loop stands in for a real run: every line it logs must reach
    // the host as an MCP progress notification (and never leak onto stdout).
    const runAgentLoop: McpDeps['runAgentLoop'] = async (opts) => {
      opts.log?.('proposing change');
      opts.log?.('running ERC');
      return runResult('success', 'abc1234');
    };
    await withServer(
      { loadConfig: async () => config, resolveModel: okModel, runAgentLoop },
      async (client) => {
        const seen: { progress: number; message?: string }[] = [];
        await client.callTool(
          { name: 'copperhead_do', arguments: { request: 'do a thing' } },
          undefined,
          { onprogress: (p) => seen.push(p) },
        );
        expect(seen.map((p) => p.message)).toEqual(['proposing change', 'running ERC']);
        // Monotonic counter so a host can order notifications and advance a bar.
        expect(seen.map((p) => p.progress)).toEqual([1, 2]);
      },
    );
  });
});

describe('key handling and honest degradation', () => {
  it('copperhead_do returns a typed error naming the env vars and starts no run when keyless', async () => {
    const runAgentLoop = vi.fn();
    await withServer(
      {
        loadConfig: async () => config,
        resolveModel: () => {
          throw new Error(
            'no model configured: pass --model codex, set COPPERHEAD_MODEL, set model in .copperhead/config.json, or provide OPENAI_API_KEY/ANTHROPIC_API_KEY',
          );
        },
        runAgentLoop: runAgentLoop as unknown as McpDeps['runAgentLoop'],
      },
      async (client) => {
        const err = await client.callTool({ name: 'copperhead_do', arguments: { request: 'x' } }).catch((e) => e);
        expect(String((err as Error).message)).toMatch(/OPENAI_API_KEY|ANTHROPIC_API_KEY/);
        expect(runAgentLoop).not.toHaveBeenCalled();
      },
    );
  });

  it('rejects an empty request before doing anything', async () => {
    const runAgentLoop = vi.fn();
    await withServer(
      { loadConfig: async () => config, resolveModel: okModel, runAgentLoop: runAgentLoop as unknown as McpDeps['runAgentLoop'] },
      async (client) => {
        const err = await client.callTool({ name: 'copperhead_do', arguments: { request: '  ' } }).catch((e) => e);
        expect(String((err as Error).message)).toMatch(/non-empty/);
        expect(runAgentLoop).not.toHaveBeenCalled();
      },
    );
  });
});

describe('per-repo serialization of mutating tools', () => {
  it('rejects a concurrent copperhead_do with a typed busy error', async () => {
    let entered!: () => void;
    const enteredP = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const releaseP = new Promise<void>((r) => (release = r));
    const runAgentLoop = vi.fn(async () => {
      entered();
      await releaseP;
      return runResult('success', 'abc1234');
    });

    await withServer(
      { loadConfig: async () => config, resolveModel: okModel, runAgentLoop: runAgentLoop as unknown as McpDeps['runAgentLoop'] },
      async (client) => {
        const first = client.callTool({ name: 'copperhead_do', arguments: { request: 'first' } });
        await enteredP; // the first run holds the mutating lock
        const err = await client.callTool({ name: 'copperhead_do', arguments: { request: 'second' } }).catch((e) => e);
        expect(String((err as Error).message)).toMatch(/already running/);
        release();
        const firstOut = JSON.parse(
          ((await first).content as { type: string; text: string }[])[0]!.text,
        );
        expect(firstOut.status).toBe('committed');
        expect(runAgentLoop).toHaveBeenCalledTimes(1);
      },
    );
  });
});

describe('copperhead_sync', () => {
  it('verify-only by default: returns the report and never runs the resolve phase', async () => {
    const report: SyncReport = {
      resolvable: [{ kind: 'drift', doc: 'BOM.md', claim: 'x', actual: 'y', resolution: 'fix it' }],
      violations: [],
    };
    const syncResolve = vi.fn(async () => ({ ok: true }));
    await withServer(
      { syncVerify: async () => report, syncResolve: syncResolve as unknown as McpDeps['syncResolve'] },
      async (client) => {
        const out = await callJson(client, 'copperhead_sync');
        expect(out.resolved).toBe(false);
        expect(out.report).toEqual(report);
        expect(syncResolve).not.toHaveBeenCalled();
      },
    );
  });

  it('with resolve=true but requirement violations present, flags them and does not auto-resolve', async () => {
    const report: SyncReport = {
      resolvable: [],
      violations: [{ kind: 'requirement-violation', description: 'U1 pin forbidden', governedBy: 'SPEC.md' }],
    };
    const syncResolve = vi.fn(async () => ({ ok: true }));
    await withServer(
      {
        loadConfig: async () => config,
        resolveModel: okModel,
        syncVerify: async () => report,
        syncResolve: syncResolve as unknown as McpDeps['syncResolve'],
      },
      async (client) => {
        const out = await callJson(client, 'copperhead_sync', { resolve: true });
        expect(out.resolved).toBe(false);
        expect(syncResolve).not.toHaveBeenCalled();
      },
    );
  });

  it('with resolve=true and no key present, refuses fast without verifying or resolving', async () => {
    const syncVerify = vi.fn(async () => ({ resolvable: [], violations: [] }) as SyncReport);
    const syncResolve = vi.fn(async () => ({ ok: true }));
    await withServer(
      {
        loadConfig: async () => config,
        resolveModel: () => {
          throw new Error(
            'no model configured: pass --model codex, set COPPERHEAD_MODEL, set model in .copperhead/config.json, or provide OPENAI_API_KEY/ANTHROPIC_API_KEY',
          );
        },
        syncVerify: syncVerify as unknown as McpDeps['syncVerify'],
        syncResolve: syncResolve as unknown as McpDeps['syncResolve'],
      },
      async (client) => {
        const err = await client
          .callTool({ name: 'copperhead_sync', arguments: { resolve: true } })
          .catch((e) => e);
        expect(String((err as Error).message)).toMatch(/OPENAI_API_KEY|ANTHROPIC_API_KEY/);
        // Fail-fast: the key check precedes even the deterministic verify phase.
        expect(syncVerify).not.toHaveBeenCalled();
        expect(syncResolve).not.toHaveBeenCalled();
      },
    );
  });
});

describe('copperhead_init', () => {
  it('returns the scaffold result', async () => {
    await withServer(
      { runInit: async () => ({ created: ['docs/BOM.md'], skipped: [], refused: [] }) },
      async (client) => {
        const out = await callJson(client, 'copperhead_init');
        expect(out.created).toContain('docs/BOM.md');
      },
    );
  });
});
