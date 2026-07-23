import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  type CallToolResult,
  type ServerNotification,
  type ServerRequest,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, resolveModel } from '../config.js';
import { runCheck } from '../commands/check.js';
import { syncVerify, syncResolve } from '../commands/sync.js';
import { runAgentLoop } from '../agent/loop.js';
import { runInit } from '../memory/scaffold.js';
import { KicadCliMissingError } from '../kicad/cli.js';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };

/**
 * The command layer, injectable so the server's serialization, result mapping,
 * and key/error handling can be tested without a live LLM or kicad-cli. Defaults
 * are the real implementations.
 */
export interface McpDeps {
  loadConfig: typeof loadConfig;
  resolveModel: typeof resolveModel;
  runCheck: typeof runCheck;
  runAgentLoop: typeof runAgentLoop;
  syncVerify: typeof syncVerify;
  syncResolve: typeof syncResolve;
  runInit: typeof runInit;
}

const REAL_DEPS: McpDeps = {
  loadConfig,
  resolveModel,
  runCheck,
  runAgentLoop,
  syncVerify,
  syncResolve,
  runInit,
};

/**
 * The whole MCP surface: four opaque, outcome-level tools. There is deliberately
 * no file-edit, raw-KiCad, or partial-loop tool — the only way to mutate the repo
 * is to run a full gated pipeline, so no sequence of calls can skip spec-gating or
 * verification-gating (design D1). Descriptions state the guarantee, not the steps.
 */
const TOOLS: Tool[] = [
  {
    name: 'copperhead_check',
    description:
      'Run the deterministic, LLM-free verification pipeline (ERC + DRC + doc-drift + constraint checks + spec validation) on the configured repo and return the structured report. Read-only; no API key required.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'copperhead_do',
    description:
      'Run the full gated design loop for one natural-language change request: propose, spec-gate, edit KiCad source, verify with ERC/DRC, repair, then commit or roll back to the pre-run snapshot. Runs non-interactively and returns a run summary (status committed/rolled_back/refused, commit, files touched, verification, transcript). Intermediate steps are not exposed. Requires an LLM API key in the environment.',
    inputSchema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'the change to make, in natural language' },
        dry_run: { type: 'boolean', description: 'propose and verify but write nothing (no commit)' },
      },
      required: ['request'],
      additionalProperties: false,
    },
  },
  {
    name: 'copperhead_sync',
    description:
      'Run the deterministic design-state verifier and return the inconsistency report. With resolve=true, also run the spec-gated LLM resolve phase to fix drift; requirement violations are flagged for a human and never auto-resolved. resolve=true requires an LLM API key.',
    inputSchema: {
      type: 'object',
      properties: {
        resolve: { type: 'boolean', description: 'run the LLM resolve phase after the verify phase' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'copperhead_init',
    description:
      'Scaffold the docs-as-memory layer (BOM, PINOUT, SPEC, decision log, config) from an existing KiCad schematic. Idempotent. No API key required.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'directory to search for KiCad files (default: repo root)' },
        force: { type: 'boolean', description: 'overwrite hand-edited generated docs' },
      },
      additionalProperties: false,
    },
  },
];

export const MCP_TOOL_NAMES = TOOLS.map((t) => t.name);

function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Forwards each loop log line to stderr (never stdout, which carries the MCP
 * JSON-RPC stream) and, when the host requested progress, as an MCP progress
 * notification so long `do`/`sync` runs do not time out (design D5).
 */
function progressLogger(extra: RequestHandlerExtra<ServerRequest, ServerNotification>): (line: string) => void {
  const meta = extra._meta as { progressToken?: string | number } | undefined;
  const token = meta?.progressToken;
  let progress = 0;
  return (line: string): void => {
    process.stderr.write(line + '\n');
    if (token !== undefined) {
      void extra
        .sendNotification({
          method: 'notifications/progress',
          params: { progressToken: token, progress: (progress += 1), message: line },
        })
        .catch(() => {});
    }
  };
}

const stderrLog = (line: string): void => {
  process.stderr.write(line + '\n');
};

/**
 * Build a stdio MCP server for one repo. Mutating tools (`do`, `sync --resolve`,
 * `init`) are serialized per repo with a typed busy error; `check` and the
 * `sync` verify phase run concurrently.
 */
export function createCopperheadMcpServer(repoRoot: string, depsOverride: Partial<McpDeps> = {}): Server {
  const deps: McpDeps = { ...REAL_DEPS, ...depsOverride };
  const server = new Server(
    { name: 'copperhead', version },
    { capabilities: { tools: {} }, instructions: 'Use these tools instead of editing .kicad_* files directly; they preserve copperhead\'s spec-gating, verification, and rollback guarantees.' },
  );

  const busy = new Set<string>();
  async function runMutating<T>(fn: () => Promise<T>): Promise<T> {
    if (busy.has(repoRoot)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `copperhead is already running a mutating operation on ${repoRoot}; wait for it to finish and retry`,
      );
    }
    busy.add(repoRoot);
    try {
      return await fn();
    } finally {
      busy.delete(repoRoot);
    }
  }

  /** Resolve the model or turn the "no key" throw into a typed protocol error naming the env vars. */
  function requireModel(config: Awaited<ReturnType<typeof loadConfig>>): { model: string; source: ReturnType<typeof resolveModel>['source'] } {
    try {
      return deps.resolveModel(undefined, config);
    } catch (err) {
      throw new McpError(ErrorCode.InvalidRequest, (err as Error).message);
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case 'copperhead_check':
          return jsonResult(await deps.runCheck(repoRoot, stderrLog));

        case 'copperhead_init':
          return await runMutating(async () =>
            jsonResult(
              await deps.runInit({
                repoRoot,
                searchPath: typeof args.path === 'string' ? args.path : '.',
                force: args.force === true,
                installHooks: true,
              }),
            ),
          );

        case 'copperhead_sync': {
          const resolve = args.resolve === true;
          if (!resolve) {
            // Verify-only: keyless and safe to run concurrently.
            return jsonResult({ resolved: false, report: await deps.syncVerify(repoRoot) });
          }
          // resolve=true asks for the LLM resolve phase: refuse fast and honestly
          // when no key resolves, before any work, exactly as copperhead_do does.
          const config = await deps.loadConfig(repoRoot);
          const { model, source } = requireModel(config);
          return await runMutating(async () => {
            const report = await deps.syncVerify(repoRoot);
            if (report.violations.length) {
              return jsonResult({
                resolved: false,
                report,
                note: 'requirement violations are never auto-resolved; a human must decide these',
              });
            }
            if (!report.resolvable.length) return jsonResult({ resolved: false, report, note: 'nothing to resolve' });
            const out = await deps.syncResolve(repoRoot, report, model, progressLogger(extra), {
              meta: { command: 'sync', modelSource: source, version },
            });
            return jsonResult({ resolved: true, ok: out.ok, report });
          });
        }

        case 'copperhead_do': {
          const requestText = args.request;
          if (typeof requestText !== 'string' || requestText.trim() === '') {
            throw new McpError(ErrorCode.InvalidParams, 'copperhead_do requires a non-empty "request" string');
          }
          // Key check before the mutating guard: a keyless host must fail fast
          // and honestly (naming the env var) without starting or blocking a run.
          const config = await deps.loadConfig(repoRoot);
          const { model, source } = requireModel(config);
          const dryRun = args.dry_run === true;
          return await runMutating(async () => {
            const res = await deps.runAgentLoop({
              repoRoot,
              request: requestText,
              model,
              interactive: false,
              dryRun,
              confirm: async () => true,
              log: progressLogger(extra),
              meta: { command: 'do', modelSource: source, version },
            });
            const status =
              res.outcome === 'refused'
                ? 'refused'
                : res.outcome === 'failure'
                  ? 'rolled_back'
                  : res.commit
                    ? 'committed'
                    : 'dry_run';
            return jsonResult({
              status,
              commit: res.commit,
              filesTouched: res.filesTouched,
              verification: res.verification,
              summary: res.summary,
              exitPath: res.exitPath,
              transcript: res.transcriptDir,
            });
          });
        }

        default:
          throw new McpError(ErrorCode.MethodNotFound, `unknown tool "${name}"`);
      }
    } catch (err) {
      if (err instanceof McpError) throw err;
      if (err instanceof KicadCliMissingError) throw new McpError(ErrorCode.InternalError, err.message);
      throw new McpError(ErrorCode.InternalError, (err as Error).message);
    }
  });

  return server;
}

/**
 * Start the server on stdio and run until the host closes the transport. The
 * server starts even without kicad-cli present: tools that need it (`check`,
 * `do`) surface a typed error at call time, while `init` and the `sync` verify
 * phase still work, and the tool list is always available.
 */
export async function startMcpServer(repoRoot: string): Promise<void> {
  const server = createCopperheadMcpServer(repoRoot);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    transport.onclose = resolve;
  });
}
