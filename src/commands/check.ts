import path from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { runErc, runDrc } from '../kicad/cli.js';
import { formatViolations, type CheckReport } from '../kicad/report.js';
import { checkDrift, emptySchematicWarning, type DriftMismatch } from '../memory/drift.js';
import { loadConstraints, checkForbiddenPins, type ConstraintViolation } from '../memory/constraints.js';
import { pinNets } from '../kicad/sexp.js';
import { openspecValidate } from '../openspec/cli.js';

export interface CheckResult {
  ok: boolean;
  erc: { ok: boolean; violations: number } | null;
  drc: { ok: boolean; violations: number } | null;
  drift: { ok: boolean; mismatches: DriftMismatch[]; warning?: string };
  openspec: { ok: boolean; detail: string } | null;
  constraints: { ok: boolean; violations: ConstraintViolation[] };
}

export async function runCheck(repoRoot: string, log: (s: string) => void): Promise<CheckResult> {
  const absoluteRepoRoot = path.resolve(repoRoot);
  const config = await loadConfig(absoluteRepoRoot);
  let erc: CheckReport | null = null;
  let drc: CheckReport | null = null;

  if (config.schematic && existsSync(path.join(absoluteRepoRoot, config.schematic))) {
    const resolvedSch = path.resolve(absoluteRepoRoot, config.schematic);
    erc = await runErc(resolvedSch);
    log(erc.ok ? 'ERC ✓' : formatViolations(erc));
  } else {
    log('ERC skipped (no schematic configured; run copperhead init)');
  }

  if (config.board && existsSync(path.join(absoluteRepoRoot, config.board))) {
    const resolvedPcb = path.resolve(absoluteRepoRoot, config.board);
    drc = await runDrc(resolvedPcb);
    log(drc.ok ? 'DRC ✓' : formatViolations(drc));
  } else {
    log('DRC skipped (no board configured)');
  }

  let drift: DriftMismatch[] = [];
  let driftWarning: string | null = null;
  if (config.schematic && existsSync(path.join(absoluteRepoRoot, config.schematic))) {
    drift = await checkDrift(absoluteRepoRoot, config.docs, config.schematic);
    log(drift.length === 0 ? 'drift ✓' : drift.map((m) => `drift: ${m.doc} claims "${m.claim}" but actual is "${m.actual}"`).join('\n'));
    driftWarning = await emptySchematicWarning(absoluteRepoRoot, config.docs, config.schematic);
    if (driftWarning) log(`drift warning: ${driftWarning}`);
  }

  let openspec: { ok: boolean; detail: string } | null = null;
  if (existsSync(path.join(absoluteRepoRoot, 'openspec', 'config.yaml'))) {
    const res = await openspecValidate(absoluteRepoRoot);
    openspec = { ok: res.ok, detail: res.output };
    log(res.ok ? 'openspec ✓' : `openspec: ${res.output}`);
  }

  let constraintViolations: ConstraintViolation[] = [];
  if (config.schematic && existsSync(path.join(absoluteRepoRoot, config.schematic))) {
    const registry = await loadConstraints(absoluteRepoRoot);
    const pins = await pinNets(path.join(absoluteRepoRoot, config.schematic));
    constraintViolations = checkForbiddenPins(registry, pins);
    if (Object.keys(registry).length) {
      log(
        constraintViolations.length === 0
          ? 'constraints ✓'
          : constraintViolations.map((v) => `constraint ${v.key}: ${v.description} (source: ${v.source})`).join('\n'),
      );
    }
  }

  const ercViolationsCount = erc?.violations.length ?? 0;
  const drcViolationsCount = drc?.violations.length ?? 0;

  const ercOk = erc ? erc.ok && ercViolationsCount === 0 : true;
  const drcOk = drc ? drc.ok && drcViolationsCount === 0 : true;
  const driftOk = drift.length === 0;
  const openspecOk = openspec?.ok ?? true;
  const constraintsOk = constraintViolations.length === 0;

  const ok = ercOk && drcOk && driftOk && openspecOk && constraintsOk;

  return {
    ok,
    erc: erc ? { ok: ercOk, violations: ercViolationsCount } : null,
    drc: drc ? { ok: drcOk, violations: drcViolationsCount } : null,
    drift: { ok: driftOk, mismatches: drift, ...(driftWarning ? { warning: driftWarning } : {}) },
    openspec,
    constraints: { ok: constraintsOk, violations: constraintViolations },
  };
}