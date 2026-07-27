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
  const resolvedFilePath = path.resolve(filePath);
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-'));
  const out = path.join(dir, `${kind}.json`);
  const sub = kind === 'erc' ? ['sch', 'erc'] : ['pcb', 'drc'];
  try {
    const res = await execa(
      'kicad-cli',
      [...sub, '--format', 'json', '--output', out, ...extraArgs, resolvedFilePath],
      { reject: false },
    );
    if (res.failed && (res as unknown as ExecaError).code === 'ENOENT') {
      throw new KicadCliMissingError();
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(out, 'utf8'));
    } catch {
      const detail = [res.stderr, res.stdout].filter(Boolean).join('\n').trim();
      throw new Error(
        `kicad-cli ${kind} produced no report — the ${kind === 'erc' ? 'schematic' : 'board'} file likely fails to load in KiCad. kicad-cli output: ${detail || '(none)'}`,
      );
    }
    const report = normalizeReport(raw, kind);
    if (report.violations.length === 0) {
      report.ok = true;
    }
    return report;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function runErc(schPath: string): Promise<CheckReport> {
  return runCheck('erc', schPath);
}

export function isProbeableKicadFile(p: string): boolean {
  return /\.kicad_(sch|pcb)$/.test(p);
}

export async function kicadLoadError(filePath: string): Promise<string | null> {
  if (!isProbeableKicadFile(filePath)) return null;
  const resolvedFilePath = path.resolve(filePath);
  const isSch = resolvedFilePath.endsWith('.kicad_sch');
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-validate-'));
  const args = isSch
    ? ['sch', 'export', 'netlist', '--output', path.join(dir, 'probe.net'), resolvedFilePath]
    : ['pcb', 'export', 'pos', '--output', path.join(dir, 'probe.pos'), resolvedFilePath];
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

export async function exportFab(pcbPath: string, schPath: string | null, outDir: string): Promise<FabExportResult> {
  const resolvedPcb = path.resolve(pcbPath);
  const resolvedSch = schPath ? path.resolve(schPath) : null;
  const resolvedOutDir = path.resolve(outDir);

  const result: FabExportResult = { produced: [], failed: [] };
  const jobs: { artifact: string; args: string[] }[] = [
    { artifact: 'gerbers', args: ['pcb', 'export', 'gerbers', '--output', path.join(resolvedOutDir, 'gerbers'), resolvedPcb] },
    { artifact: 'drill', args: ['pcb', 'export', 'drill', '--output', path.join(resolvedOutDir, 'gerbers'), resolvedPcb] },
    { artifact: 'outline.dxf', args: ['pcb', 'export', 'dxf', '--output', path.join(resolvedOutDir, 'outline.dxf'), '--layers', 'Edge.Cuts', resolvedPcb] },
    { artifact: 'board.step', args: ['pcb', 'export', 'step', '--output', path.join(resolvedOutDir, 'board.step'), resolvedPcb] },
    { artifact: 'board.svg', args: ['pcb', 'export', 'svg', '--output', path.join(resolvedOutDir, 'board.svg'), '--layers', 'F.Cu,B.Cu,Edge.Cuts', resolvedPcb] },
  ];
  if (resolvedSch) {
    jobs.push({ artifact: 'schematic.svg', args: ['sch', 'export', 'svg', '--output', path.join(resolvedOutDir, 'renders'), resolvedSch] });
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

export async function exportSvg(kind: 'sch' | 'pcb', filePath: string, outDir: string): Promise<string> {
  const resolvedFilePath = path.resolve(filePath);
  const resolvedOutDir = path.resolve(outDir);

  const args =
    kind === 'sch'
      ? ['sch', 'export', 'svg', '--output', resolvedOutDir, resolvedFilePath]
      : ['pcb', 'export', 'svg', '--output', path.join(resolvedOutDir, 'board.svg'), '--layers', 'F.Cu,B.Cu,Edge.Cuts', resolvedFilePath];
  try {
    await execa('kicad-cli', args);
  } catch (err) {
    if ((err as ExecaError).code === 'ENOENT') throw new KicadCliMissingError();
    throw err;
  }
  return resolvedOutDir;
}