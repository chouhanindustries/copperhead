import path from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { runErc, runDrc } from '../kicad/cli.js';
import { formatViolations, type CheckReport } from '../kicad/report.js';
import { checkDrift, emptySchematicWarning, type DriftMismatch } from '../memory/drift.js';
import { loadConstraints, checkForbiddenPins, type ConstraintViolation } from '../memory/constraints.js';
import { pinNets } from '../kicad/sexp.js';
import { openspecValidate } from '../openspec/cli.js';

/**
 * `copperhead check` (alias `verify`): deterministic, zero LLM calls, CI-safe
 * (AC-2). This module must never import a provider.
 */
export interface CheckResult {
  ok: boolean;
  erc: { ok: boolean; violations: number } | null;
  drc: { ok: boolean; violations: number } | null;
  drift: { ok: boolean; mismatches: DriftMismatch[]; warning?: string };
  openspec: { ok: boolean; detail: string } | null;
  constraints: { ok: boolean; violations: ConstraintViolation[] };
  /**
   * The configured schematic path, when it is configured but absent from disk.
   * A repo with no schematic configured has genuinely nothing to verify and
   * stays green; a repo that was configured to be checked and quietly stopped
   * being checked is a different thing, and must not read as a pass.
   */
  schematicMissing: string | null;
}

export async function runCheck(repoRoot: string, log: (s: string) => void): Promise<CheckResult> {
  const config = await loadConfig(repoRoot);
  let erc: CheckReport | null = null;
  let drc: CheckReport | null = null;

  // ERC, drift and the constraint check all gate on this one condition, so it
  // is resolved once rather than re-tested three times with the same bug.
  const schematicPath = config.schematic ? path.join(repoRoot, config.schematic) : null;
  const schematicUsable = schematicPath !== null && existsSync(schematicPath);
  const schematicMissing = config.schematic && !schematicUsable ? config.schematic : null;

  if (schematicUsable) {
    erc = await runErc(schematicPath);
    log(erc.ok ? 'ERC ✓' : formatViolations(erc));
  } else if (schematicMissing) {
    // `copperhead init` is the wrong remedy here: the config is fine, the file
    // it points at is not. Say which path, so a typo or a rename is obvious.
    log(`ERC skipped: schematic configured at ${schematicMissing} but the file is missing`);
  } else {
    log('ERC skipped (no schematic configured; run copperhead init)');
  }

  if (config.board && existsSync(path.join(repoRoot, config.board))) {
    drc = await runDrc(path.join(repoRoot, config.board));
    log(drc.ok ? 'DRC ✓' : formatViolations(drc));
  } else {
    log('DRC skipped (no board configured)');
  }

  let drift: DriftMismatch[] = [];
  let driftWarning: string | null = null;
  if (schematicUsable && config.schematic) {
    drift = await checkDrift(repoRoot, config.docs, config.schematic);
    log(drift.length === 0 ? 'drift ✓' : drift.map((m) => `drift: ${m.doc} claims "${m.claim}" but actual is "${m.actual}"`).join('\n'));
    // Informational, never a failure: the zero-symbol drift exemption is for
    // bootstrap, but an established repo that lost its schematic content
    // deserves a visible note rather than a silent green.
    driftWarning = await emptySchematicWarning(repoRoot, config.docs, config.schematic);
    if (driftWarning) log(`drift warning: ${driftWarning}`);
  }

  let openspec: { ok: boolean; detail: string } | null = null;
  if (existsSync(path.join(repoRoot, 'openspec', 'config.yaml'))) {
    const res = await openspecValidate(repoRoot);
    openspec = { ok: res.ok, detail: res.output };
    log(res.ok ? 'openspec ✓' : `openspec: ${res.output}`);
  }

  let constraintViolations: ConstraintViolation[] = [];
  if (schematicUsable) {
    const registry = await loadConstraints(repoRoot);
    const pins = await pinNets(schematicPath);
    constraintViolations = checkForbiddenPins(registry, pins);
    if (Object.keys(registry).length) {
      log(
        constraintViolations.length === 0
          ? 'constraints ✓'
          : constraintViolations.map((v) => `constraint ${v.key}: ${v.description} (source: ${v.source})`).join('\n'),
      );
    }
  }

  // `?? true` is right for a check that had nothing to run, but it cannot tell
  // "nothing to verify" from "everything to verify, silently skipped", so the
  // missing-schematic case is failed explicitly rather than defaulted to true.
  const ok =
    schematicMissing === null &&
    (erc?.ok ?? true) &&
    (drc?.ok ?? true) &&
    drift.length === 0 &&
    (openspec?.ok ?? true) &&
    constraintViolations.length === 0;

  return {
    ok,
    erc: erc ? { ok: erc.ok, violations: erc.violations.length } : null,
    drc: drc ? { ok: drc.ok, violations: drc.violations.length } : null,
    drift: { ok: drift.length === 0, mismatches: drift, ...(driftWarning ? { warning: driftWarning } : {}) },
    openspec,
    constraints: { ok: constraintViolations.length === 0, violations: constraintViolations },
    schematicMissing,
  };
}
