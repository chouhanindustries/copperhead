import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fabricationGerberLayers, requiredFabArtifacts } from './cli.js';

export const EXPORT_RECEIPT = path.join('outputs', '.copperhead-export.json');

interface ExportReceipt {
  schemaVersion: 1;
  artifacts: string[];
  sources: { board: ReceiptFile; schematic?: ReceiptFile; bom: ReceiptFile };
  gerberLayers: string[];
  files: ReceiptFile[];
}

interface ReceiptFile {
  path: string;
  bytes: number;
  sha256: string;
}

function canonicalGeneratedArtifact(rel: string, data: Buffer): Buffer {
  if (!rel.split(path.sep).join('/').startsWith('outputs/')) return data;
  const text = data.toString('utf8');
  if (text.includes('\u0000') || text.includes('\ufffd')) return data;
  const canonical = text
    .replace(
      /(<title>SVG Image created as [^<]*? date )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?(\s*<\/title>)/g,
      '$1<volatile-date>$2',
    )
    .replace(/^([ \t]*G04 #@! TF\.CreationDate,)[^*\r\n]*(\*)$/gm, '$1<volatile-date>$2')
    .replace(/^([ \t]*%TF\.CreationDate,)[^*\r\n]*(\*%)$/gm, '$1<volatile-date>$2')
    .replace(/^([ \t]*G04 Created by KiCad \(.*\) date )[^*\r\n]*(\*)$/gm, '$1<volatile-date>$2')
    .replace(/^([ \t]*; #@! TF\.CreationDate,)[^\r\n]*$/gm, '$1<volatile-date>')
    .replace(/^([ \t]*; DRILL file (?:\{)?KiCad [^}\r\n]+(?:\})? date )[^\r\n]*$/gim, '$1<volatile-date>')
    .replace(
      /(^FILE_NAME\s*\([\s\S]*?\b'?)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?('?\s*[\s\S]*?\);)/m,
      '$1<volatile-date>$2',
    )
    .replace(/("CreationDate"\s*:\s*")[^"]*(")/g, '$1<volatile-date>$2');
  return canonical === text ? data : Buffer.from(canonical, 'utf8');
}

async function digestFile(repoRoot: string, rel: string): Promise<ReceiptFile> {
  const absolute = path.join(repoRoot, rel);
  const data = canonicalGeneratedArtifact(rel, await readFile(absolute));
  return {
    path: rel.split(path.sep).join('/'),
    bytes: data.byteLength,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
}

async function matchingFiles(dir: string, exts: string[]): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await matchingFiles(absolute, exts)));
    else if (exts.some((ext) => entry.name.toLowerCase().endsWith(ext)) && (await stat(absolute)).size > 0) {
      found.push(absolute);
    }
  }
  return found.sort();
}

async function gerberJobPaths(gerbersDir: string, expectedLayerCount: number): Promise<string[]> {
  if (expectedLayerCount === 0) return [];
  const jobs = await matchingFiles(gerbersDir, ['.gbrjob']);
  if (jobs.length !== 1) return [];
  try {
    const parsed = JSON.parse(await readFile(jobs[0]!, 'utf8')) as {
      FilesAttributes?: { Path?: string; FileFunction?: string }[];
    };
    const attributes = parsed.FilesAttributes ?? [];
    if (attributes.length !== expectedLayerCount || attributes.some((entry) => !entry.Path || !entry.FileFunction)) return [];
    const files = attributes.map((entry) => path.resolve(gerbersDir, entry.Path!));
    if (files.some((file) => path.dirname(file) !== path.resolve(gerbersDir))) return [];
    for (const file of files) {
      const info = await stat(file);
      if (!info.isFile() || info.size === 0) return [];
    }
    return [...files, jobs[0]!].sort();
  } catch {
    return [];
  }
}

async function concreteOutputPaths(repoRoot: string, hasSchematic: boolean, expectedLayerCount: number): Promise<string[]> {
  const out = path.join(repoRoot, 'outputs');
  const gerbers = await gerberJobPaths(path.join(out, 'gerbers'), expectedLayerCount);
  const drills = await matchingFiles(path.join(out, 'gerbers'), ['.drl']);
  const renders = hasSchematic ? await matchingFiles(path.join(out, 'renders'), ['.svg']) : [];
  const fixed = ['outline.dxf', 'board.step', 'board.svg', 'BOM.csv'].map((name) => path.join(out, name));
  if (!gerbers.length || !drills.length || (hasSchematic && !renders.length)) return [];
  for (const file of fixed) {
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size === 0) return [];
    } catch {
      return [];
    }
  }
  return [...gerbers, ...drills, ...fixed, ...renders]
    .map((absolute) => path.relative(repoRoot, absolute))
    .sort();
}

export async function invalidateExportReceipt(repoRoot: string): Promise<void> {
  await rm(path.join(repoRoot, EXPORT_RECEIPT), { force: true });
}

export async function writeExportReceipt(args: {
  repoRoot: string;
  board: string;
  schematic: string | null;
  bom: string;
  artifacts: string[];
}): Promise<void> {
  const expectedArtifacts = requiredFabArtifacts(Boolean(args.schematic));
  if (JSON.stringify([...args.artifacts].sort()) !== JSON.stringify([...expectedArtifacts].sort())) {
    throw new Error('exporter did not report every required artifact');
  }
  const gerberLayers = await fabricationGerberLayers(path.join(args.repoRoot, args.board));
  const paths = await concreteOutputPaths(args.repoRoot, Boolean(args.schematic), gerberLayers.length);
  if (!paths.length) throw new Error('export package is incomplete or contains an empty required file');
  const receipt: ExportReceipt = {
    schemaVersion: 1,
    artifacts: expectedArtifacts,
    sources: {
      board: await digestFile(args.repoRoot, args.board),
      ...(args.schematic ? { schematic: await digestFile(args.repoRoot, args.schematic) } : {}),
      bom: await digestFile(args.repoRoot, args.bom),
    },
    gerberLayers,
    files: await Promise.all(paths.map((rel) => digestFile(args.repoRoot, rel))),
  };
  const destination = path.join(args.repoRoot, EXPORT_RECEIPT);
  const temporary = `${destination}.tmp`;
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  await rename(temporary, destination);
}

export async function exportReceiptMatches(args: {
  repoRoot: string;
  board: string;
  schematic: string | null;
  bom: string;
}): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(path.join(args.repoRoot, EXPORT_RECEIPT), 'utf8')) as ExportReceipt;
    if (raw.schemaVersion !== 1 || !Array.isArray(raw.artifacts) || !Array.isArray(raw.files)) return false;
    const expectedArtifacts = requiredFabArtifacts(Boolean(args.schematic));
    if (JSON.stringify([...raw.artifacts].sort()) !== JSON.stringify([...expectedArtifacts].sort())) return false;
    if (raw.sources.board.path !== args.board.split(path.sep).join('/')) return false;
    if (raw.sources.bom.path !== args.bom.split(path.sep).join('/')) return false;
    if (Boolean(raw.sources.schematic) !== Boolean(args.schematic)) return false;
    if (args.schematic && raw.sources.schematic?.path !== args.schematic.split(path.sep).join('/')) return false;

    const gerberLayers = await fabricationGerberLayers(path.join(args.repoRoot, args.board));
    if (JSON.stringify(raw.gerberLayers) !== JSON.stringify(gerberLayers)) return false;
    const currentPaths = await concreteOutputPaths(args.repoRoot, Boolean(args.schematic), gerberLayers.length);
    const recordedPaths = raw.files.map((file) => file.path).sort();
    if (JSON.stringify(currentPaths.map((rel) => rel.split(path.sep).join('/')).sort()) !== JSON.stringify(recordedPaths)) {
      return false;
    }
    const expected = [
      raw.sources.board,
      ...(raw.sources.schematic ? [raw.sources.schematic] : []),
      raw.sources.bom,
      ...raw.files,
    ];
    for (const recorded of expected) {
      if (recorded.bytes <= 0) return false;
      const actual = await digestFile(args.repoRoot, recorded.path);
      if (actual.bytes !== recorded.bytes || actual.sha256 !== recorded.sha256) return false;
    }
    return true;
  } catch {
    return false;
  }
}
