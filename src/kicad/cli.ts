import { execa, ExecaError } from 'execa';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeReport, type CheckReport } from './report.js';
import { PreflightError } from '../util/preflight.js';

export class KicadCliMissingError extends PreflightError {
  constructor() {
    super(
      'kicad-cli not found on PATH',
      'copperhead verifies every mutation with kicad-cli ERC/DRC; without it no edit can be checked, so no run can start',
      [
        'install KiCad ≥ 8: https://www.kicad.org/download/',
        'ensure the kicad-cli binary is on PATH (on macOS it ships inside KiCad.app/Contents/MacOS)',
        'confirm with "kicad-cli version", then rerun',
      ],
    );
    this.name = 'KicadCliMissingError';
  }
}

export async function kicadCliVersion(): Promise<string> {
  try {
    const { stdout } = await execa('kicad-cli', ['version']);
    return stdout.trim();
  } catch (err) {
    if ((err as ExecaError).code === 'ENOENT') throw new KicadCliMissingError();
    throw err;
  }
}

async function runCheck(
  kind: 'erc' | 'drc',
  filePath: string,
  extraArgs: string[] = [],
): Promise<CheckReport> {
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-'));
  const out = path.join(dir, `${kind}.json`);
  const sub = kind === 'erc' ? ['sch', 'erc'] : ['pcb', 'drc'];
  try {
    const res = await execa(
      'kicad-cli',
      [...sub, '--format', 'json', '--exit-code-violations', '--output', out, ...extraArgs, filePath],
      { reject: false },
    );
    if (res.failed && (res as unknown as ExecaError).code === 'ENOENT') {
      throw new KicadCliMissingError();
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(out, 'utf8'));
    } catch {
      // No report on disk means kicad-cli bailed before checking — usually the
      // design file itself failed to load (syntax/schema corruption). The
      // raw readFile ENOENT told the agent nothing actionable; kicad-cli's
      // own output at least names the failure.
      const detail = [res.stderr, res.stdout].filter(Boolean).join('\n').trim();
      throw new Error(
        `kicad-cli ${kind} produced no report — the ${kind === 'erc' ? 'schematic' : 'board'} file likely fails to load in KiCad. kicad-cli output: ${detail || '(none)'}`,
      );
    }
    return normalizeReport(raw, kind);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function runErc(schPath: string): Promise<CheckReport> {
  return runCheck('erc', schPath);
}

/**
 * Cheap loadability probe for a KiCad file: asks kicad-cli for a throwaway
 * export and reports the failure text if the file won't load. Text edits on
 * s-expression sources can silently corrupt the file; catching that at edit
 * time (with KiCad's own error) beats an opaque failure at ERC/DRC time.
 * Returns null when the file loads.
 */
/**
 * Only schematics and boards have a cheap standalone load probe. Project
 * files and symbol/footprint libraries do not: feeding them to a sch/pcb
 * export "probe" would reject perfectly good files.
 */
export function isProbeableKicadFile(p: string): boolean {
  return /\.kicad_(sch|pcb)$/.test(p);
}

export async function kicadLoadError(filePath: string): Promise<string | null> {
  if (!isProbeableKicadFile(filePath)) return null;
  const isSch = filePath.endsWith('.kicad_sch');
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-validate-'));
  const args = isSch
    ? ['sch', 'export', 'netlist', '--output', path.join(dir, 'probe.net'), filePath]
    : ['pcb', 'export', 'pos', '--output', path.join(dir, 'probe.pos'), filePath];
  try {
    const res = await execa('kicad-cli', args, { reject: false });
    if (res.failed && (res as unknown as ExecaError).code === 'ENOENT') throw new KicadCliMissingError();
    if (res.exitCode === 0) return null;
    return [res.stderr, res.stdout].filter(Boolean).join('\n').trim() || `kicad-cli exited ${res.exitCode}`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function runDrc(pcbPath: string): Promise<CheckReport> {
  return runCheck('drc', pcbPath);
}

export interface FabExportResult {
  produced: string[];
  failed: { artifact: string; reason: string }[];
}

/**
 * Export the fabrication package (SPEC §2.5 outputs): gerbers + drill, DXF and
 * STEP outline, SVG renders. Each artifact fails independently with a reason so
 * a missing STEP exporter never sinks the rest of the package.
 */
export async function exportFab(pcbPath: string, schPath: string | null, outDir: string): Promise<FabExportResult> {
  const result: FabExportResult = { produced: [], failed: [] };
  const jobs: { artifact: string; args: string[] }[] = [
    { artifact: 'gerbers', args: ['pcb', 'export', 'gerbers', '--output', path.join(outDir, 'gerbers'), pcbPath] },
    { artifact: 'drill', args: ['pcb', 'export', 'drill', '--output', path.join(outDir, 'gerbers'), pcbPath] },
    { artifact: 'outline.dxf', args: ['pcb', 'export', 'dxf', '--output', path.join(outDir, 'outline.dxf'), '--layers', 'Edge.Cuts', pcbPath] },
    { artifact: 'board.step', args: ['pcb', 'export', 'step', '--output', path.join(outDir, 'board.step'), pcbPath] },
    { artifact: 'board.svg', args: ['pcb', 'export', 'svg', '--output', path.join(outDir, 'board.svg'), '--layers', 'F.Cu,B.Cu,Edge.Cuts', pcbPath] },
  ];
  if (schPath) {
    jobs.push({ artifact: 'schematic.svg', args: ['sch', 'export', 'svg', '--output', path.join(outDir, 'renders'), schPath] });
  }
  for (const job of jobs) {
    try {
      await execa('kicad-cli', job.args);
      result.produced.push(job.artifact);
    } catch (err) {
      if ((err as ExecaError).code === 'ENOENT') throw new KicadCliMissingError();
      result.failed.push({ artifact: job.artifact, reason: String((err as ExecaError).stderr ?? (err as Error).message).slice(0, 200) });
    }
  }
  return result;
}

/** Export an SVG render of a schematic or board; returns the output directory. */
export async function exportSvg(kind: 'sch' | 'pcb', filePath: string, outDir: string): Promise<string> {
  const args =
    kind === 'sch'
      ? ['sch', 'export', 'svg', '--output', outDir, filePath]
      : ['pcb', 'export', 'svg', '--output', path.join(outDir, 'board.svg'), '--layers', 'F.Cu,B.Cu,Edge.Cuts', filePath];
  try {
    await execa('kicad-cli', args);
  } catch (err) {
    if ((err as ExecaError).code === 'ENOENT') throw new KicadCliMissingError();
    throw err;
  }
  return outDir;
}
