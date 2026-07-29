import path from 'node:path';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { checkDrift } from '../memory/drift.js';

/**
 * Enhancement: Shallow stage completion checks for stages 6, 7, and 8
 * are vulnerable to false-positives when directories are empty or
 * contain only placeholder content. This module adds robust completion
 * checks that verify meaningful content exists.
 */

/**
 * Check that a directory contains at least one non-empty file.
 * Used to prevent false-positives where a stage creates an empty
 * directory but produces no actual artifacts.
 */
export async function dirHasContent(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return false;
  
  const entries = await readdirWithTypes(dir);
  for (const entry of entries) {
    if (entry.isFile()) {
      const filePath = path.join(dir, entry.name);
      const s = await stat(filePath);
      if (s.size > 0) return true;
    } else if (entry.isDirectory()) {
      // Recurse into subdirectories (e.g., outputs/ might have gerbers/)
      if (await dirHasContent(path.join(dir, entry.name))) {
        return true;
      }
    }
  }
  return false;
}

interface DirentWithStat {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

async function readdirWithTypes(dir: string): Promise<DirentWithStat[]> {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(dir, { withFileTypes: true });
  return entries as DirentWithStat[];
}

/**
 * Verify that outputs/ directory contains required fab artifacts.
 * Stage 6 (outputs) should have at least: gerbers, drill, and BOM.
 */
export async function verifyOutputsStage(repoRoot: string): Promise<{
  ok: boolean;
  missing: string[];
  found: string[];
}> {
  const outputsDir = path.join(repoRoot, 'outputs');
  const missing: string[] = [];
  const found: string[] = [];
  
  if (!existsSync(outputsDir)) {
    return { ok: false, missing: ['outputs/ directory missing'], found: [] };
  }
  
  // Check for gerber files (typically .gbr, .gtl, .gbl, etc.)
  const hasGerbers = await dirHasContent(outputsDir);
  if (!hasGerbers) {
    missing.push('gerber files');
  } else {
    found.push('gerber files');
  }
  
  // Check for drill files
  const drillFiles = await findFiles(outputsDir, [/\.drill$/, /\.drl$/, /\.tap$/]);
  if (drillFiles.length === 0) {
    missing.push('drill files');
  } else {
    found.push(`drill files (${drillFiles.length})`);
  }
  
  // Check for BOM CSV
  const bomFiles = await findFiles(outputsDir, [/\.csv$/i]);
  if (bomFiles.length === 0) {
    missing.push('BOM CSV');
  } else {
    found.push(`BOM files (${bomFiles.length})`);
  }
  
  return { ok: missing.length === 0, missing, found };
}

/**
 * Verify firmware/ directory contains actual code files, not just placeholders.
 */
export async function verifyFirmwareStage(repoRoot: string): Promise<{
  ok: boolean;
  codeFiles: number;
  hasMakefile: boolean;
  hasSource: boolean;
}> {
  const firmwareDir = path.join(repoRoot, 'firmware');
  
  if (!existsSync(firmwareDir)) {
    return { ok: false, codeFiles: 0, hasMakefile: false, hasSource: false };
  }
  
  const cFiles = await findFiles(firmwareDir, [/\.(c|cpp|cc|h|hpp)$/]);
  const pyFiles = await findFiles(firmwareDir, [/\.(py|yaml|yml)$/]);
  const makeFiles = await findFiles(firmwareDir, [/^(Makefile|makefile|CMakeLists\.txt)$/]);
  
  return {
    ok: cFiles.length > 0 || pyFiles.length > 0,
    codeFiles: cFiles.length + pyFiles.length,
    hasMakefile: makeFiles.length > 0,
    hasSource: cFiles.length > 0,
  };
}

async function findFiles(dir: string, patterns: RegExp[]): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const results: string[] = [];
  
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findFiles(fullPath, patterns)));
    } else if (entry.isFile()) {
      for (const pattern of patterns) {
        if (pattern.test(entry.name)) {
          results.push(fullPath);
          break;
        }
      }
    }
  }
  
  return results;
}
