import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface CopperheadConfig {
  schematic: string | null;
  board: string | null;
  docs: string;
  model: string | null;
  maxTurns: number;
  /** Per-stage overrides for the create pipeline, keyed by stage name. */
  stageMaxTurns?: Record<string, number>;
  maxRepairCycles: number;
  budgets: Record<string, number>;
  /** Per-turn watchdog (ms). A provider turn exceeding this is aborted and
   * retried, so a hung call can't stall the run forever. <=0 disables it. */
  turnTimeoutMs: number;
  /** How often (ms) to emit a liveness heartbeat while a provider turn is in
   * flight, so a slow large-output turn is distinguishable from a hung one
   * (5.1). Fires only after the first interval, so quick turns stay silent.
   * <=0 disables it. */
  heartbeatMs: number;
  /** How many times the create pipeline may auto-retry a stage that failed or
   * ended without meeting its contract, gated by an LLM diagnosis each time. */
  maxStageRetries: number;
  /** Cache each turn's LLM response to disk and replay it on identical inputs,
   * so retries/restarts reuse work already paid for. Default on. */
  llmCache: boolean;
  /** Content hashes of generated docs, for init idempotency (AC-1.4). */
  generatedHashes?: Record<string, string>;
  /**
   * How the repo was bootstrapped. `"create"` marks a Mode A pipeline repo
   * (fab gate requires DEVPLAN.md). Written by `copperhead create`; absent on
   * init-only / hand-maintained repos.
   */
  origin?: 'create' | 'init';
  /**
   * Base URL for an OpenAI-compatible endpoint (e.g. Groq, Ollama, OpenRouter,
   * Cerebras). Consulted only by the explicit `compat:<model-id>` model route
   * (see makeProvider in agent/loop.ts) — never by `gpt-5` or any other model
   * id — so a value configured here can never silently redirect an unrelated
   * run. Overridden at runtime by the `COPPERHEAD_BASE_URL` env var.
   */
  openaiCompatBaseUrl?: string;
  /**
   * Name of the environment variable that holds the API key for the configured
   * OpenAI-compatible endpoint (e.g. `"GROQ_API_KEY"`, `"OPENROUTER_API_KEY"`).
   * The key value is never stored in config — only the variable name is.
   * Defaults to `OPENAI_API_KEY` when not set. Can be overridden at runtime
   * with the `COPPERHEAD_API_KEY_ENV` env var.
   */
  openaiCompatApiKeyEnv?: string;
}

export const CONFIG_DIR = '.copperhead';

export const DEFAULTS: Omit<CopperheadConfig, 'schematic' | 'board'> = {
  docs: 'docs/',
  model: null,
  maxTurns: 40,
  maxRepairCycles: 5,
  budgets: {},
  // 10 min. A single large capture turn (a full lib_symbols + instances edit,
  // ~40k output tokens) on the claude-code provider legitimately runs several
  // minutes; the old 5-min deadline killed those mid-flight and, because the
  // watchdog budget is spent per stage, could fail a stage that was only slow,
  // not hung. 10 min clears the largest observed turns while still catching a
  // genuinely stuck subprocess.
  turnTimeoutMs: 600000,
  // 30s: within one interval an operator knows a turn is alive, and a full
  // 10-min turn emits ~20 lines — enough to distinguish slow from hung without
  // flooding the log. Quick turns (< 30s) emit nothing.
  heartbeatMs: 30000,
  maxStageRetries: 2,
  llmCache: true,
};

export function configPath(repoRoot: string): string {
  return path.join(repoRoot, CONFIG_DIR, 'config.json');
}

export async function loadConfig(repoRoot: string): Promise<CopperheadConfig> {
  const p = configPath(repoRoot);
  if (!existsSync(p)) {
    return { schematic: null, board: null, ...DEFAULTS };
  }
  const raw = JSON.parse(await readFile(p, 'utf8')) as Partial<CopperheadConfig>;
  // A zero/negative/non-integer stage budget would exhaust the stage on turn 0;
  // drop such entries rather than let a config typo stall the pipeline.
  const stageMaxTurns = Object.fromEntries(
    Object.entries(raw.stageMaxTurns ?? {}).filter(([, v]) => Number.isInteger(v) && v > 0),
  );
  return {
    schematic: raw.schematic ?? null,
    board: raw.board ?? null,
    docs: raw.docs ?? DEFAULTS.docs,
    model: raw.model ?? null,
    maxTurns: raw.maxTurns ?? DEFAULTS.maxTurns,
    ...(Object.keys(stageMaxTurns).length ? { stageMaxTurns } : {}),
    maxRepairCycles: raw.maxRepairCycles ?? DEFAULTS.maxRepairCycles,
    budgets: raw.budgets ?? {},
    turnTimeoutMs: typeof raw.turnTimeoutMs === 'number' ? raw.turnTimeoutMs : DEFAULTS.turnTimeoutMs,
    heartbeatMs: typeof raw.heartbeatMs === 'number' ? raw.heartbeatMs : DEFAULTS.heartbeatMs,
    maxStageRetries:
      Number.isInteger(raw.maxStageRetries) && (raw.maxStageRetries as number) >= 0
        ? (raw.maxStageRetries as number)
        : DEFAULTS.maxStageRetries,
    llmCache: raw.llmCache !== false,
    ...(raw.generatedHashes ? { generatedHashes: raw.generatedHashes } : {}),
    ...(raw.origin === 'create' || raw.origin === 'init' ? { origin: raw.origin } : {}),
    // .trim() so a blank-but-present field (an empty string left over from a
    // template, or whitespace) is treated as absent rather than as a configured
    // value that would then need to be re-checked for blankness at every call site.
    ...(typeof raw.openaiCompatBaseUrl === 'string' && raw.openaiCompatBaseUrl.trim()
      ? { openaiCompatBaseUrl: raw.openaiCompatBaseUrl.trim() }
      : {}),
    ...(typeof raw.openaiCompatApiKeyEnv === 'string' && raw.openaiCompatApiKeyEnv.trim()
      ? { openaiCompatApiKeyEnv: raw.openaiCompatApiKeyEnv.trim() }
      : {}),
  };
}

/** Which level of the model-selection precedence chain won. */
export type ModelSource = 'flag' | 'env' | 'config' | 'openai-key' | 'anthropic-key' | 'picker';

const AUTO_FALLBACK_CANDIDATES: { keyVar: 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY'; model: string; source: ModelSource }[] = [
  { keyVar: 'OPENAI_API_KEY', model: 'gpt-5', source: 'openai-key' },
  { keyVar: 'ANTHROPIC_API_KEY', model: 'claude', source: 'anthropic-key' },
];

export interface ResolvedModel {
  model: string;
  source: ModelSource;
}

/**
 * Model selection precedence: flag > COPPERHEAD_MODEL > config > available key.
 * The winning source is returned alongside the model so run metadata can
 * record why a run used the model it did (AC-8.1/8.2).
 *
 * Accepted values (same set for `--model`, COPPERHEAD_MODEL, and `model` in
 * .copperhead/config.json):
 *
 * - `cursor`          : the Cursor Agent CLI using saved login (`agent login`).
 * - `cursor:<id>`     : the same provider on a specific model id.
 * - `claude-code`     : the Claude Code saved-login provider on its default
 *                       model. Needs NO API key — it reuses the logged-in Claude
 *                       Code CLI / CLAUDE_CODE_OAUTH_TOKEN via the Agent SDK.
 * - `claude-code:<id>`: the same provider on a specific model id.
 * - `claude`  : the Anthropic API provider on its default model.
 * - `claude-*`: any Anthropic API model id, passed through verbatim, e.g.
 *               `claude-opus-4-5`. Anything starting with `claude` routes here.
 * - `codex`   : the locally installed Codex CLI using its saved ChatGPT login.
 * - `codex:*` : Codex CLI with an explicit model id, e.g. `codex:gpt-5.6`.
 * - `gpt-5`   : the OpenAI provider on its default model.
 * - `compat:<model-id>`: an OpenAI-compatible endpoint (Groq, Cerebras,
 *               OpenRouter, Gemini's compat endpoint, a local Ollama) —
 *               requires `openaiCompatBaseUrl`/`COPPERHEAD_BASE_URL` to be
 *               set (see resolveCompatSettings below). This is the *only*
 *               model string that reads those settings; deliberately opt-in
 *               so a stray configured base URL never redirects a plain
 *               `gpt-5`/`claude` run.
 * - anything else: sent to the OpenAI provider verbatim as a model id, e.g.
 *               `gpt-5-mini` or `o3`.
 *
 * Routing is prefix-based, not a fixed list (see makeProvider in agent/loop.ts),
 * matched top to bottom: `claude-code`/`claude-code:<id>` is checked BEFORE the
 * `claude*` prefix, so it is never captured by the Anthropic API route. A model
 * released after this build still works without a code change. The cost is that
 * a typo like `claud-sonnet-5` silently routes to OpenAI and fails there.
 * Anthropic and direct OpenAI providers require their API keys; `codex` requires
 * a locally installed and authenticated Codex CLI, and `claude-code` requires a
 * Claude Code login (CLAUDE_CODE_OAUTH_TOKEN); `cursor` requires `agent login`.
 * None of the saved-login providers need a model API key.
 *
 * With no flag/env/config model at all, exactly one of OPENAI_API_KEY /
 * ANTHROPIC_API_KEY present auto-selects that provider. With both present and
 * nothing else breaking the tie, this throws an "ambiguous:" error rather than
 * silently guessing — a wrong silent guess can route a request to a paid
 * provider the caller didn't intend to use.
 */
export function resolveModel(flag: string | undefined, config: CopperheadConfig, env = process.env): ResolvedModel {
  if (flag) return { model: flag, source: 'flag' };
  if (env.COPPERHEAD_MODEL) return { model: env.COPPERHEAD_MODEL, source: 'env' };
  if (config.model) return { model: config.model, source: 'config' };
  // Auto-fallback only guesses when exactly one credential is present: with
  // nothing else to pick from, there is nothing to guess wrong. With two or
  // more keys set (common once a compat endpoint's key sits alongside
  // OPENAI_API_KEY/ANTHROPIC_API_KEY in the same .env), silently favoring
  // whichever is checked first can route a request to the wrong provider —
  // including a paid one — with no signal a choice was even made. The compat
  // route is never an auto-fallback candidate: it only activates through an
  // explicit `compat:` prefix (see agent/loop.ts's makeProvider).
  const available = AUTO_FALLBACK_CANDIDATES.filter((c) => env[c.keyVar]);
  if (available.length === 1) return { model: available[0]!.model, source: available[0]!.source };
  if (available.length > 1) {
    throw new Error(
      `ambiguous: ${available.length} credentials found (${available.map((c) => c.keyVar).join(', ')}) and no model was selected; ` +
        'pass --model, set COPPERHEAD_MODEL, or set "model" in .copperhead/config.json.',
    );
  }
  throw new Error(
    'no model configured: pass --model, set COPPERHEAD_MODEL, or export an API key; see https://docs.copperhead.sh/reference/configuration/',
  );
}

/** Where an OpenAI-compatible `compat:<model-id>` run points, and which env var holds its key. */
export interface CompatSettings {
  /** Endpoint base URL; undefined means no endpoint is configured. */
  openaiCompatBaseUrl?: string;
  /** Name of the env var holding the key. Never the key value itself. */
  openaiCompatApiKeyEnv: string;
}

/** The credential variable used for a compat endpoint when nothing else is configured. */
export const DEFAULT_OPENAI_COMPAT_API_KEY_ENV = 'OPENAI_API_KEY';

/**
 * Resolve the `compat:` route's endpoint settings: env overrides config, the
 * same direction as `resolveModel`'s own chain. These are settings for that
 * route only — nothing else reads them, so a stray `COPPERHEAD_BASE_URL` can
 * never redirect a plain `gpt-5`/`claude` run (only `compat:<id>` consults
 * this at all; see makeProvider in agent/loop.ts).
 */
export function resolveCompatSettings(config: CopperheadConfig, env = process.env): CompatSettings {
  const openaiCompatBaseUrl = env.COPPERHEAD_BASE_URL?.trim() || config.openaiCompatBaseUrl;
  const openaiCompatApiKeyEnv =
    env.COPPERHEAD_API_KEY_ENV?.trim() || config.openaiCompatApiKeyEnv || DEFAULT_OPENAI_COMPAT_API_KEY_ENV;
  return { ...(openaiCompatBaseUrl ? { openaiCompatBaseUrl } : {}), openaiCompatApiKeyEnv };
}

/**
 * True when `baseURL` is a loopback host (e.g. a local Ollama), which serves
 * the same API with no credential. `.local` (mDNS/LAN) hosts count as local
 * for this purpose — reaching them needs no key — but see the narrower
 * loopback-only check in doctor.ts's privacy warning, where a LAN host is NOT
 * exempt: that traffic does leave the machine, even if it needs no key.
 */
export function isLocalEndpoint(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  try {
    const h = new URL(baseURL).hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.local');
  } catch {
    return false; // an unparseable URL is not a local endpoint; the run fails later with a clearer error
  }
}

/**
 * Hosts whose free tier is documented as training on submitted prompts.
 * Keyed on hostname, not model/tier name — hostnames are stable, tier names
 * rot in months, so the tier detail belongs in docs, not this map.
 */
const PROMPT_PRIVACY_RISK_HOSTS: Record<string, string> = {
  'generativelanguage.googleapis.com': "Gemini's free tier may train on submitted prompts",
  'openrouter.ai': 'OpenRouter `:free` models may route to providers that train on prompts',
};

/**
 * True loopback only — deliberately narrower than `isLocalEndpoint`, which
 * also treats `.local` (mDNS/LAN) hosts as needing no credential. That is
 * correct for "does this need a key" (many LAN-hosted servers skip auth) but
 * wrong for the privacy bypass below: a request to `nas.local` genuinely
 * leaves the machine onto the LAN to a different physical device, so "nothing
 * leaves the machine" does not hold the way it does for real loopback.
 */
function isTrueLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

export type PromptPrivacyRisk =
  | { kind: 'none' }
  | { kind: 'unknown'; host: string }
  | { kind: 'risk'; host: string; reason: string };

/**
 * Classifies whether a `compat:<model-id>` run's configured endpoint carries a
 * documented prompt-training risk. Shared by the run-start transcript notice
 * (agent/loop.ts) and `copperhead doctor`'s preflight check (commands/doctor.ts)
 * so the host list and matching rules — subdomain matching, the loopback
 * bypass, OpenRouter's `:free`-suffix-only risk — live in exactly one place.
 * Non-compat models, an unconfigured endpoint, an unparseable URL, and true
 * loopback all classify as `'none'` (nothing to warn about).
 */
export function classifyPromptPrivacy(model: string, compat: CompatSettings | undefined): PromptPrivacyRisk {
  if (model !== 'compat' && !model.startsWith('compat:')) return { kind: 'none' };
  if (!compat?.openaiCompatBaseUrl) return { kind: 'none' };
  let host: string;
  try {
    host = new URL(compat.openaiCompatBaseUrl).hostname.toLowerCase();
  } catch {
    return { kind: 'none' };
  }
  if (isTrueLoopbackHost(host)) return { kind: 'none' };
  const risk = Object.entries(PROMPT_PRIVACY_RISK_HOSTS).find(([h]) => host === h || host.endsWith(`.${h}`));
  if (!risk) return { kind: 'unknown', host };
  // OpenRouter's documented risk is specific to its `:free`-suffixed models,
  // not the host as a whole; warning on a fully paid OpenRouter model would be
  // a false positive that undermines trust in the other, host-wide warnings.
  if (risk[0] === 'openrouter.ai') {
    const compatModel = model.startsWith('compat:') ? model.slice('compat:'.length) : '';
    if (!compatModel.endsWith(':free')) return { kind: 'unknown', host };
  }
  return { kind: 'risk', host, reason: risk[1] };
}
