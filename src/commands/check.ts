import path from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { runErc, runDrc } from '../kicad/cli.js';
import { formatViolations, type CheckReport } from '../kicad/report.js';
import { checkDrift, emptySchematicWarning, type DriftMismatch } from '../memory/drift.js';
import { loadConstraints, checkForbiddenPins, type ConstraintViolation } from '../memory/constraints.js';
import { pinNets } from '../kicad/sexp.js';
import { openspecValidate } from '../openspec/cli.js';

import { runFabGateCheck, type FabGateReport } from '../kicad/fab.js';

/**
 * `copperhead check` (alias `verify`): deterministic, zero LLM calls, CI-safe
 * (AC-2). This module must never import a provider.
 */
export interface CheckOptions {
  fab?: boolean;
  strict?: boolean;
}

export interface CheckResult {
  ok: boolean;
  erc: { ok: boolean; violations: number } | null;
  drc: { ok: boolean; violations: number } | null;
  drift: { ok: boolean; mismatches: DriftMismatch[]; warning?: string };
  openspec: { ok: boolean; detail: string } | null;
  constraints: { ok: boolean; violations: ConstraintViolation[] };
  fab?: FabGateReport;
}

export async function runCheck(
  repoRoot: string,
  log: (s: string) => void,
  options: CheckOptions = {},
): Promise<CheckResult> {
  const config = await loadConfig(repoRoot);
  let erc: CheckReport | null = null;
  let drc: CheckReport | null = null;

  if (config.schematic && existsSync(path.join(repoRoot, config.schematic))) {
    erc = await runErc(path.join(repoRoot, config.schematic));
    log(erc.ok ? 'ERC ✓' : formatViolations(erc));
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
  if (config.schematic && existsSync(path.join(repoRoot, config.schematic))) {
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
  if (config.schematic && existsSync(path.join(repoRoot, config.schematic))) {
    const registry = await loadConstraints(repoRoot);
    const pins = await pinNets(path.join(repoRoot, config.schematic));
    constraintViolations = checkForbiddenPins(registry, pins);
    if (Object.keys(registry).length) {
      log(
        constraintViolations.length === 0
          ? 'constraints ✓'
          : constraintViolations.map((v) => `constraint ${v.key}: ${v.description} (source: ${v.source})`).join('\n'),
      );
    }
  }

  let fabReport: FabGateReport | undefined;
  if (options.fab) {
    fabReport = await runFabGateCheck(repoRoot, config, {
      strict: options.strict,
      drcReport: drc ?? undefined,
    });

    const mark = (status: 'pass' | 'warn' | 'fail') =>
      status === 'pass' ? '✓' : status === 'warn' ? '⚠' : '✗';

    log(`fab: routing ${mark(fabReport.routing.status)}`);
    for (const v of fabReport.routing.violations) log(`  - [routing] ${v.actual}`);

    log(`fab: bom ${mark(fabReport.bom.status)}`);
    for (const v of fabReport.bom.violations) log(`  - [bom] ${v.actual}`);

    log(`fab: schematic-to-PCB match ${mark(fabReport.schPcbMatch.status)}`);
    for (const v of fabReport.schPcbMatch.violations) log(`  - [schPcbMatch] ${v.actual}`);

    log(`fab: output freshness ${mark(fabReport.outputs.status)}`);
    for (const v of fabReport.outputs.violations) log(`  - [outputs] ${v.actual}`);

    log(`fab: documentation presence ${mark(fabReport.docs.status)}`);
    for (const v of fabReport.docs.violations) log(`  - [docs] ${v.actual}`);
  }

  const ok =
    (erc?.ok ?? true) &&
    (drc?.ok ?? true) &&
    drift.length === 0 &&
    (openspec?.ok ?? true) &&
    constraintViolations.length === 0 &&
    (fabReport?.ok ?? true);

  return {
    ok,
    erc: erc ? { ok: erc.ok, violations: erc.violations.length } : null,
    drc: drc ? { ok: drc.ok, violations: drc.violations.length } : null,
    drift: { ok: drift.length === 0, mismatches: drift, ...(driftWarning ? { warning: driftWarning } : {}) },
    openspec,
    constraints: { ok: constraintViolations.length === 0, violations: constraintViolations },
    ...(fabReport ? { fab: fabReport } : {}),
  };
}
