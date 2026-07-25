import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CopperheadConfig as Config } from '../config.js';
import { CheckReport as DrcReport } from './report.js';
import { listSymbols, listBoardFootprints } from './sexp.js';
import { parseBom } from './bom-export.js';

export interface FabViolation {
  claim: string;
  actual: string;
  location?: { x: number; y: number } | string;
}

export interface FabGateCheckResult {
  status: 'pass' | 'warn' | 'fail';
  violations: FabViolation[];
}

export interface FabGateReport {
  ok: boolean;
  routing: FabGateCheckResult;
  bom: FabGateCheckResult;
  schPcbMatch: FabGateCheckResult;
  outputs: FabGateCheckResult;
  docs: FabGateCheckResult;
}

export interface FabOptions {
  strict?: boolean;
  drcReport?: DrcReport;
}

export async function computeFileHash(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

export const CREATE_ORIGIN = 'create';

export function draftQualitySection(layoutMd: string | null): string | null {
  if (!layoutMd) return null;
  const match = layoutMd.match(/##\s+Draft quality\s*([\s\S]*?)(?=\n##\s+|$)/i);
  return match ? match[1] ?? null : null;
}

export function isFilledDraftQuality(body: string): boolean {
  const cleaned = body.replace(/<!--[\s\S]*?-->/g, '').trim();
  return cleaned.length > 0;
}

export function isCreateProducedRepo(cfg?: { origin?: string } | null): boolean {
  return Boolean(cfg && cfg.origin === CREATE_ORIGIN);
}

export function checkDocumentationPresence(opts: {
  layoutMd: string | null;
  devplanExists: boolean;
  isCreateRepo?: boolean;
}): FabGateCheckResult {
  const violations: FabViolation[] = [];
  const section = draftQualitySection(opts.layoutMd);
  if (opts.layoutMd === null) {
    violations.push({
      claim: 'release-ready',
      actual: 'LAYOUT.md missing',
      location: 'docs/LAYOUT.md',
    });
  } else if (section === null) {
    violations.push({
      claim: 'release-ready',
      actual: 'missing ## Draft quality section',
      location: 'docs/LAYOUT.md',
    });
  } else if (!isFilledDraftQuality(section)) {
    violations.push({
      claim: 'release-ready',
      actual: '## Draft quality section is empty',
      location: 'docs/LAYOUT.md',
    });
  }

  if (opts.isCreateRepo && !opts.devplanExists) {
    violations.push({
      claim: 'release-ready',
      actual: 'missing',
      location: 'docs/DEVPLAN.md',
    });
  }

  return {
    status: violations.length > 0 ? 'fail' : 'pass',
    violations,
  };
}

export async function runFabGateCheck(
  repoRoot: string,
  config: Config,
  options: FabOptions = {},
): Promise<FabGateReport> {
  const strict = options.strict ?? false;

  // 1. Routing completeness check
  const routingViolations: FabViolation[] = [];
  if (options.drcReport) {
    const unconnected = options.drcReport.violations.filter(
      (v) =>
        v.type.toLowerCase().includes('unconnected') ||
        v.description.toLowerCase().includes('unconnected'),
    );
    for (const v of unconnected) {
      routingViolations.push({
        claim: 'Routing complete (0 unconnected items)',
        actual: `Unconnected item: ${v.description}`,
        location:
          v.items[0]?.x !== undefined && v.items[0]?.y !== undefined
            ? { x: v.items[0].x, y: v.items[0].y }
            : undefined,
      });
    }
  } else {
    routingViolations.push({
      claim: 'Routing verified via DRC',
      actual: 'DRC report is missing or DRC failed to run',
    });
  }

  const routingStatus: 'pass' | 'warn' | 'fail' =
    routingViolations.length > 0 ? 'fail' : 'pass';

  // 2. BOM readiness check
  const bomViolations: FabViolation[] = [];
  let hasBomUnverifiedWarning = false;
  const bomPath = path.join(repoRoot, 'docs', 'BOM.md');

  if (!existsSync(bomPath)) {
    bomViolations.push({
      claim: 'docs/BOM.md exists',
      actual: 'docs/BOM.md does not exist',
    });
  } else {
    try {
      const md = await readFile(bomPath, 'utf8');
      const rows = parseBom(md);
      for (const row of rows) {
        if (!row.footprint || row.footprint.trim() === '' || row.footprint.trim() === '-') {
          bomViolations.push({
            claim: `Refdes ${row.refdes} has valid footprint`,
            actual: `Refdes ${row.refdes} missing footprint`,
          });
        }
        if (!row.hasMpn && !row.unverified) {
          bomViolations.push({
            claim: `Refdes ${row.refdes} has valid MPN`,
            actual: `Refdes ${row.refdes} missing MPN`,
          });
        }
        if (row.unverified) {
          hasBomUnverifiedWarning = true;
          bomViolations.push({
            claim: `Refdes ${row.refdes} verified`,
            actual: `Refdes ${row.refdes} is UNVERIFIED`,
          });
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      bomViolations.push({
        claim: 'BOM.md is valid',
        actual: `Failed to parse BOM.md: ${msg}`,
      });
    }
  }

  const hasBomFailures = bomViolations.some(
    (v: FabViolation) => !v.actual.includes('UNVERIFIED') || strict,
  );

  let bomStatus: 'pass' | 'warn' | 'fail' = 'pass';
  if (hasBomFailures) {
    bomStatus = 'fail';
  } else if (hasBomUnverifiedWarning) {
    bomStatus = 'warn';
  }

  // 3. Schematic-to-PCB match check
  const matchViolations: FabViolation[] = [];
  const schRel = config.schematic;
  const boardRel = config.board;

  if (!schRel || !boardRel) {
    matchViolations.push({
      claim: 'Schematic and PCB configured',
      actual: 'Schematic or PCB path is not configured',
    });
  } else {
    const schPath = path.join(repoRoot, schRel);
    const boardPath = path.join(repoRoot, boardRel);

    if (existsSync(schPath) && existsSync(boardPath)) {
      let schSymbols: SchematicSymbol[] = [];
      try {
        schSymbols = await listSymbols(schPath);
      } catch (err) {
        matchViolations.push({
          claim: 'Schematic parses successfully',
          actual: err instanceof Error ? err.message : String(err),
        });
      }

      let boardFps: BoardFootprint[] = [];
      try {
        boardFps = await listBoardFootprints(boardPath);
      } catch (err) {
        matchViolations.push({
          claim: 'PCB parses successfully',
          actual: err instanceof Error ? err.message : String(err),
        });
      }

      const schMap = new Map<string, string>();
      for (const s of schSymbols) {
        // filter out power symbols or pseudo-symbols if ref starts with #
        if (s.ref && !s.ref.startsWith('#')) {
          schMap.set(s.ref, s.footprint);
        }
      }

      const pcbMap = new Map<string, string>();
      for (const f of boardFps) {
        if (f.ref && !f.ref.startsWith('#')) {
          pcbMap.set(f.ref, f.footprint);
        }
      }

      for (const [ref, schFp] of schMap) {
        const pcbFp = pcbMap.get(ref);
        if (!pcbFp) {
          matchViolations.push({
            claim: `Refdes ${ref} present on PCB`,
            actual: `Refdes ${ref} present in schematic but missing from PCB`,
          });
        } else {
          const normSchFp = schFp.includes(':') ? schFp.split(':')[1]! : schFp;
          const normPcbFp = pcbFp.includes(':') ? pcbFp.split(':')[1]! : pcbFp;
          if (normSchFp && normPcbFp && normSchFp !== normPcbFp) {
            matchViolations.push({
              claim: `Refdes ${ref} footprint match`,
              actual: `Refdes ${ref} footprint mismatch: schematic "${schFp}" vs PCB "${pcbFp}"`,
            });
          }
        }
      }

      for (const [ref] of pcbMap) {
        if (!schMap.has(ref)) {
          matchViolations.push({
            claim: `Refdes ${ref} present in schematic`,
            actual: `Refdes ${ref} present on PCB but missing from schematic`,
          });
        }
      }
    } else {
      matchViolations.push({
        claim: 'Schematic and PCB files exist',
        actual: 'Schematic or PCB file is missing',
      });
    }
  }

  const schPcbMatchStatus: 'pass' | 'warn' | 'fail' =
    matchViolations.length > 0 ? 'fail' : 'pass';

  // 4. Output freshness check
  const outputViolations: FabViolation[] = [];
  const outputsDir = path.join(repoRoot, 'outputs');

  if (!existsSync(outputsDir)) {
    outputViolations.push({
      claim: 'Outputs directory exists',
      actual: "Outputs missing. Run 'copperhead export fab' to generate.",
    });
  } else if (boardRel && existsSync(path.join(repoRoot, boardRel))) {
    const boardPath = path.join(repoRoot, boardRel);
    const currentHash = await computeFileHash(boardPath);
    const configPath = path.join(repoRoot, '.copperhead', 'config.json');

    let recordedHash: string | undefined;
    if (existsSync(configPath)) {
      try {
        const parsedCfg = JSON.parse(await readFile(configPath, 'utf8'));
        recordedHash = parsedCfg.exportHash?.boardHash;
      } catch {
        // ignore parse error
      }
    }

    if (!recordedHash) {
      outputViolations.push({
        claim: 'Export hash record exists in config.json',
        actual: "Export hash record missing. Run 'copperhead export fab' to generate.",
      });
    } else if (recordedHash !== currentHash) {
      outputViolations.push({
        claim: 'Gerber and drill package is fresh',
        actual: "Gerber and drill package is stale. Run 'copperhead export fab' to regenerate.",
      });
    }
  } else {
    outputViolations.push({
      claim: 'PCB file exists for hash check',
      actual: 'PCB file is missing or not configured',
    });
  }

  const outputsStatus: 'pass' | 'warn' | 'fail' =
    outputViolations.length > 0 ? 'fail' : 'pass';

  // 5. Documentation presence check
  const layoutPath = path.join(repoRoot, 'docs', 'LAYOUT.md');
  const layoutMd = existsSync(layoutPath) ? await readFile(layoutPath, 'utf8') : null;
  const devplanPath = path.join(repoRoot, 'docs', 'DEVPLAN.md');
  const devplanExists = existsSync(devplanPath);

  const docsRes = checkDocumentationPresence({
    layoutMd,
    devplanExists,
    isCreateRepo: isCreateProducedRepo(config),
  });

  const ok =
    routingStatus === 'pass' &&
    (bomStatus === 'pass' || (bomStatus === 'warn' && !strict)) &&
    schPcbMatchStatus === 'pass' &&
    outputsStatus === 'pass' &&
    docsRes.status === 'pass';

  return {
    ok,
    routing: { status: routingStatus, violations: routingViolations },
    bom: { status: bomStatus, violations: bomViolations },
    schPcbMatch: { status: schPcbMatchStatus, violations: matchViolations },
    outputs: { status: outputsStatus, violations: outputViolations },
    docs: docsRes,
  };
}
