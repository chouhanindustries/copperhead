import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DEFAULTS, loadConfig, resolveModel, type CopperheadConfig } from '../config.js';
import { kicadCliVersion } from '../kicad/cli.js';
import { redactSecrets } from '../util/redact.js';
import { isPrivacySensitiveEndpoint } from '../agent/loop.js';

const execFileP = promisify(execFile);

/**
 * `copperhead doctor` (env preflight): a fast, LLM-free, network-free check of
 * whether this machine can actually run a copperhead command — the gap `check`
 * leaves (it verifies kicad-cli but is contractually LLM-free, so it never looks
 * at the model provider). Each probe fails soft: a missing tool is a reported
 * `fail`, never a thrown error, so `doctor` still prints the rest of the report.
 */
export type DoctorStatus = 'ok' | 'fail' | 'info';

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  hint?: string;
}

export interface DoctorReport {
  /** true when no *critical* check failed (info-only checks never block). */
  ok: boolean;
  checks: DoctorCheck[];
}

/** Probes are injectable so tests never depend on the host's tools. */
export interface DoctorDeps {
  nodeVersion: string;
  kicadVersion: () => Promise<string>;
  gitVersion: () => Promise<string>;
  env: NodeJS.ProcessEnv;
}

function defaultDeps(): DoctorDeps {
  return {
    nodeVersion: process.version,
    kicadVersion: kicadCliVersion,
    // `git --version` prints "git version 2.34.1"; keep only the number, the
    // report already labels the row "git".
    gitVersion: async () => (await execFileP('git', ['--version'])).stdout.trim().replace(/^git version\s+/, ''),
    env: process.env,
  };
}

const MIN_NODE_MAJOR = 20; // package.json engines: ">=20"

function nodeCheck(version: string): DoctorCheck {
  const major = Number(version.replace(/^v/, '').split('.')[0]);
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) {
    return { name: 'node', status: 'ok', detail: `${version} (>= ${MIN_NODE_MAJOR})` };
  }
  return {
    name: 'node',
    status: 'fail',
    detail: `${version} (< ${MIN_NODE_MAJOR})`,
    hint: `copperhead needs Node >= ${MIN_NODE_MAJOR}; upgrade Node.`,
  };
}

async function kicadCheck(probe: () => Promise<string>): Promise<DoctorCheck> {
  try {
    return { name: 'kicad-cli', status: 'ok', detail: await probe() };
  } catch {
    return {
      name: 'kicad-cli',
      status: 'fail',
      detail: 'not found on PATH',
      hint: 'install KiCad >= 9 (bundles kicad-cli); ERC/DRC gates need it.',
    };
  }
}

async function gitCheck(probe: () => Promise<string>): Promise<DoctorCheck> {
  try {
    return { name: 'git', status: 'ok', detail: await probe() };
  } catch {
    return {
      name: 'git',
      status: 'fail',
      detail: 'not found on PATH',
      hint: 'install git; copperhead snapshots and commits its work.',
    };
  }
}

/**
 * Map a resolved model to the credential its provider needs, mirroring
 * makeProvider's prefix routing (agent/loop.ts). Presence-only: it checks that a
 * required API key is set, never that it authenticates (that would need network).
 * Saved-login providers (codex, claude-code) need no key and can't be verified
 * offline, so they report `info` (which does not block `ok`).
 */
export function checkCredential(
  model: string,
  env: NodeJS.ProcessEnv,
  config?: Pick<CopperheadConfig, 'openaiCompatBaseUrl' | 'openaiCompatApiKeyEnv'>,
): DoctorCheck {
  // A pasted API key can end up as the model value (--model sk-..., a stray
  // COPPERHEAD_MODEL); redact it before it reaches the report, same policy as
  // transcripts (AC-4.1). Routing below still uses the raw value.
  const shown = redactSecrets(model);
  const savedLogin: Record<string, string> = {
    codex: 'uses local Codex login',
    'claude-code': 'uses Claude Code login',
    cursor: 'uses Cursor Agent CLI login',
  };
  for (const [prefix, how] of Object.entries(savedLogin)) {
    if (model === prefix || model.startsWith(`${prefix}:`)) {
      // makeProvider rejects an empty override; a real run would fail here.
      if (model === `${prefix}:`) {
        return {
          name: 'provider',
          status: 'fail',
          detail: `${shown} -> ${prefix}: empty model override`,
          hint: `use "${prefix}" or "${prefix}:<model-id>".`,
        };
      }
      return {
        name: 'provider',
        status: 'info',
        detail: `${shown} -> ${prefix}: ${how} (not verified offline)`,
      };
    }
  }
  if (model === 'claude' || model.startsWith('claude')) {
    return env.ANTHROPIC_API_KEY
      ? { name: 'provider', status: 'ok', detail: `${shown} -> anthropic: ANTHROPIC_API_KEY set` }
      : {
          name: 'provider',
          status: 'fail',
          detail: `${shown} -> anthropic: ANTHROPIC_API_KEY not set`,
          hint: 'export ANTHROPIC_API_KEY=... (or use --model claude-code for saved login).',
        };
  }
  // OpenAI or OpenAI-compatible endpoint.
  const baseURL = env.COPPERHEAD_BASE_URL ?? config?.openaiCompatBaseUrl;
  const apiKeyEnvName = env.COPPERHEAD_API_KEY_ENV ?? config?.openaiCompatApiKeyEnv ?? 'OPENAI_API_KEY';
  const key = env[apiKeyEnvName];
  const endpointStr = baseURL ? ` -> ${baseURL}` : ' -> api.openai.com (default)';
  return key
    ? { name: 'provider', status: 'ok', detail: `${shown} -> openai-compat: ${apiKeyEnvName} set${endpointStr}` }
    : {
        name: 'provider',
        status: 'fail',
        detail: `${shown} -> openai-compat: ${apiKeyEnvName} not set${endpointStr}`,
        hint: baseURL
          ? `export ${apiKeyEnvName}=... (key for ${baseURL}). Or set COPPERHEAD_API_KEY_ENV to the correct env var name.`
          : 'export OPENAI_API_KEY=... (or use --model codex for saved login).',
      };
}

function providerCheck(
  flag: string | undefined,
  config: Awaited<ReturnType<typeof loadConfig>>,
  env: NodeJS.ProcessEnv,
): DoctorCheck[] {
  try {
    const { model } = resolveModel(flag, config, env);
    const cred = checkCredential(model, env, config);
    const checks: DoctorCheck[] = [cred];
    // Append a privacy info row for known free-tier endpoints.
    const baseURL = env.COPPERHEAD_BASE_URL ?? config.openaiCompatBaseUrl;
    if (isPrivacySensitiveEndpoint(baseURL, model)) {
      checks.push({
        name: 'privacy',
        status: 'info',
        detail: 'this provider/tier may use prompt data for training — PCB designs are often proprietary; verify the data policy before running on confidential hardware',
      });
    }
    return checks;
  } catch (err) {
    // resolveModel throws only when nothing selects a model at all. Its message
    // starts with "no model configured: " — already this check's detail line —
    // so keep only the remedy part for the hint.
    return [{
      name: 'provider',
      status: 'fail',
      detail: 'no model configured',
      hint: (err as Error).message.replace(/^no model configured:\s*/, ''),
    }];
  }
}


function projectCheck(config: Awaited<ReturnType<typeof loadConfig>>, repoRoot: string): DoctorCheck {
  const hasConfig = existsSync(path.join(repoRoot, '.copperhead', 'config.json'));
  if (!hasConfig) {
    return {
      name: 'project',
      status: 'info',
      detail: 'no .copperhead/config.json (run `copperhead init` to scaffold)',
    };
  }
  return {
    name: 'project',
    status: 'info',
    detail: `schematic ${config.schematic ?? 'not wired'} · board ${config.board ?? 'not wired'}`,
  };
}

export interface RunDoctorOptions {
  repoRoot: string;
  model?: string | undefined;
  deps?: Partial<DoctorDeps>;
}

// Same shape loadConfig returns when no config file exists at all: a safe
// fallback so a corrupted config.json degrades the project check, not the
// whole command (resolveModel's config.model precedence level is simply
// unavailable; --model/COPPERHEAD_MODEL/an available key still resolve).
const FALLBACK_CONFIG: CopperheadConfig = { schematic: null, board: null, ...DEFAULTS };

export async function runDoctor(opts: RunDoctorOptions): Promise<DoctorReport> {
  const deps = { ...defaultDeps(), ...opts.deps };
  let config: CopperheadConfig;
  let configError: DoctorCheck | undefined;
  try {
    config = await loadConfig(opts.repoRoot);
  } catch (err) {
    config = FALLBACK_CONFIG;
    // JSON.parse throws a bare SyntaxError for bad content; readFile throws a
    // coded Error (EACCES, EISDIR, ...) for a file that couldn't be read at
    // all. The two need different advice: content is fixed by regenerating
    // the file, unreadable is a permissions/filesystem problem regenerating
    // it will not solve.
    configError =
      err instanceof SyntaxError
        ? {
            name: 'project',
            status: 'fail',
            detail: `.copperhead/config.json is malformed: ${err.message}`,
            hint: 'fix or delete .copperhead/config.json (rerun `copperhead init`/`copperhead create` to regenerate it).',
          }
        : {
            name: 'project',
            status: 'fail',
            detail: `.copperhead/config.json could not be read: ${(err as Error).message}`,
            hint: 'check that it is a regular file (not a directory) and that you have permission to read it.',
          };
  }
  const checks: DoctorCheck[] = [
    nodeCheck(deps.nodeVersion),
    await kicadCheck(deps.kicadVersion),
    await gitCheck(deps.gitVersion),
    ...providerCheck(opts.model, config, deps.env),
    configError ?? projectCheck(config, opts.repoRoot),
  ];
  return { ok: checks.every((c) => c.status !== 'fail'), checks };
}

const TAG: Record<DoctorStatus, string> = { ok: '[ok]', fail: '[FAIL]', info: '[info]' };
const TAG_COL = 2; // leading indent
const NAME_COL = TAG_COL + 7; // widest tag "[FAIL]" + one space
const DETAIL_COL = NAME_COL + 10; // widest name "kicad-cli" + one space

// Plain ANSI, no color dependency: green/red/cyan tags, dim hints. Color is
// off by default; the CLI opts in only for a real TTY, so piped output and
// tests see plain text. Colored text is padded before painting — escape codes
// have zero display width but nonzero string length, so painting first would
// break the column math.
const ANSI: Record<DoctorStatus, string> = { ok: '32', fail: '31', info: '36' };
const DIM = '2';
function paint(text: string, code: string, on: boolean): string {
  return on ? `\u001b[${code}m${text}\u001b[0m` : text;
}

function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Continuation lines land in the same column as the first, so wrapped text reads as one block. */
function pushWrapped(lines: string[], first: string, text: string, col: number, width: number): void {
  const wrapped = wrapWords(text, Math.max(20, width - col));
  lines.push(first + (wrapped[0] ?? ''));
  for (const rest of wrapped.slice(1)) lines.push(' '.repeat(col) + rest);
}

export function formatDoctor(report: DoctorReport, width = 80, color = false): string[] {
  const lines: string[] = [];
  for (const c of report.checks) {
    const tag = paint(TAG[c.status], ANSI[c.status], color) + ' '.repeat(NAME_COL - TAG_COL - TAG[c.status].length);
    const head = ' '.repeat(TAG_COL) + tag + c.name.padEnd(DETAIL_COL - NAME_COL);
    pushWrapped(lines, head, c.detail, DETAIL_COL, width);
    if (c.hint) {
      const start = lines.length;
      pushWrapped(lines, `${' '.repeat(NAME_COL)}hint: `, c.hint, NAME_COL + 6, width);
      for (let i = start; i < lines.length; i++) lines[i] = paint(lines[i]!, DIM, color);
    }
  }
  lines.push(
    report.ok ? paint('ready', ANSI.ok, color) : paint('not ready: fix the [FAIL] items above', ANSI.fail, color),
  );
  return lines;
}
