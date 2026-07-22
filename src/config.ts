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
  /** Content hashes of generated docs, for init idempotency (AC-1.4). */
  generatedHashes?: Record<string, string>;
}

export const CONFIG_DIR = '.copperhead';

export const DEFAULTS: Omit<CopperheadConfig, 'schematic' | 'board'> = {
  docs: 'docs/',
  model: null,
  maxTurns: 40,
  maxRepairCycles: 5,
  budgets: {},
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
    ...(raw.generatedHashes ? { generatedHashes: raw.generatedHashes } : {}),
  };
}

/** Which level of the model-selection precedence chain won. */
export type ModelSource = 'flag' | 'env' | 'config' | 'openai-key' | 'anthropic-key';

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
 * - `claude`  : the Anthropic provider on its default model.
 * - `claude-*`: any Anthropic model id, passed through verbatim, e.g.
 *               `claude-opus-4-5`. Anything starting with `claude` routes here.
 * - `gpt-5`   : the OpenAI provider on its default model.
 * - anything else: sent to the OpenAI provider verbatim as a model id, e.g.
 *               `gpt-5-mini` or `o3`.
 *
 * Routing is prefix-based, not a fixed list (see makeProvider in agent/loop.ts),
 * so a model released after this build still works without a code change. The
 * cost is that a typo like `claud-sonnet-5` silently routes to OpenAI and fails
 * there. The chosen provider must have its key set: ANTHROPIC_API_KEY for
 * `claude*`, OPENAI_API_KEY otherwise.
 */
export function resolveModel(flag: string | undefined, config: CopperheadConfig, env = process.env): ResolvedModel {
  if (flag) return { model: flag, source: 'flag' };
  if (env.COPPERHEAD_MODEL) return { model: env.COPPERHEAD_MODEL, source: 'env' };
  if (config.model) return { model: config.model, source: 'config' };
  if (env.OPENAI_API_KEY) return { model: 'gpt-5', source: 'openai-key' };
  if (env.ANTHROPIC_API_KEY) return { model: 'claude', source: 'anthropic-key' };
  throw new Error(
    'no model configured: pass --model, set COPPERHEAD_MODEL, set model in .copperhead/config.json, or provide OPENAI_API_KEY/ANTHROPIC_API_KEY',
  );
}
