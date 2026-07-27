import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { listSymbols, listNets, pinNets, type SchematicSymbol, type PinNet } from '../kicad/sexp.js';

export class ExplainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExplainError';
  }
}

export interface ExplainResult {
  target: string;
  kind: 'refdes' | 'pin' | 'net';
  symbol?: SchematicSymbol;
  pins?: PinNet[];
  net?: string;
  bomRationale?: string;
}

async function tryReadBomRationale(repoRoot: string, docsDir: string, ref: string): Promise<string | undefined> {
  const p = path.join(repoRoot, docsDir, 'BOM.md');
  if (!existsSync(p)) return undefined;
  try {
    const text = await readFile(p, 'utf8');
    const refUpper = ref.toUpperCase();
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line.startsWith('|')) continue;
      const cells = line.split('|').map((c) => c.trim());
      if (cells.length >= 6 && cells[1]?.toUpperCase() === refUpper) {
        return cells[5] || undefined;
      }
    }
  } catch {
    // Optional docs lookup - ignore read errors
  }
  return undefined;
}

export async function runExplain(repoRoot: string, target: string): Promise<ExplainResult> {
  const config = await loadConfig(repoRoot);
  if (!config.schematic || !existsSync(path.join(repoRoot, config.schematic))) {
    throw new ExplainError('no schematic configured; run copperhead init');
  }

  const schPath = path.join(repoRoot, config.schematic);
  const [symbols, allPinNets, allNets] = await Promise.all([
    listSymbols(schPath),
    pinNets(schPath),
    listNets(schPath),
  ]);

  const targetTrimmed = target.trim();
  const targetLower = targetTrimmed.toLowerCase();

  // 1. Try Pin match ("U1.1")
  if (targetTrimmed.includes('.')) {
    const [refPart, pinPart] = targetTrimmed.split('.');
    if (refPart && pinPart) {
      const refLower = refPart.toLowerCase();
      const pinLower = pinPart.toLowerCase();

      const matchedPin = allPinNets.find(
        (p) =>
          p.ref.toLowerCase() === refLower &&
          (p.pinNumber.toLowerCase() === pinLower || p.pinName.toLowerCase() === pinLower),
      );

      if (matchedPin) {
        const parentSymbol = symbols.find((s) => s.ref.toLowerCase() === refLower);
        return {
          target,
          kind: 'pin',
          pins: [matchedPin],
          symbol: parentSymbol,
        };
      }
    }
  }

  // 2. Try Refdes match ("U1")
  const matchedSymbol = symbols.find((s) => s.ref.toLowerCase() === targetLower);
  if (matchedSymbol) {
    const symbolPins = allPinNets.filter((p) => p.ref.toLowerCase() === targetLower);
    const bomRationale = await tryReadBomRationale(repoRoot, config.docs, matchedSymbol.ref);
    return {
      target,
      kind: 'refdes',
      symbol: matchedSymbol,
      pins: symbolPins,
      bomRationale,
    };
  }

  // 3. Try Net match ("GND")
  const isKnownNet = allNets.some((n) => n.toLowerCase() === targetLower);
  const netPins = allPinNets.filter((p) => p.net && p.net.toLowerCase() === targetLower);
  if (isKnownNet || netPins.length > 0) {
    const canonicalNet = allNets.find((n) => n.toLowerCase() === targetLower) ?? targetTrimmed;
    return {
      target,
      kind: 'net',
      net: canonicalNet,
      pins: netPins,
    };
  }

  throw new ExplainError(`target "${target}" not found in schematic`);
}

export function formatExplainReport(res: ExplainResult): string {
  if (res.kind === 'refdes' && res.symbol) {
    const lines = [
      `Symbol ${res.symbol.ref}:`,
      `  Value: ${res.symbol.value}`,
      `  Lib: ${res.symbol.libId}`,
      `  Footprint: ${res.symbol.footprint || '(none)'}`,
      `  Sheet: ${res.symbol.sheet}`,
    ];
    if (res.bomRationale) {
      lines.push(`  BOM Rationale: ${res.bomRationale}`);
    }
    if (res.pins && res.pins.length > 0) {
      lines.push(`  Pins (${res.pins.length}):`);
      for (const p of res.pins) {
        lines.push(`    ${p.pinNumber} (${p.pinName}): ${p.net || '(unconnected)'}`);
      }
    }
    return lines.join('\n');
  }

  if (res.kind === 'pin' && res.pins && res.pins.length > 0) {
    const p = res.pins[0]!;
    const lines = [
      `Pin ${p.ref}.${p.pinNumber} (${p.pinName}):`,
      `  Net: ${p.net || '(unconnected)'}`,
    ];
    if (res.symbol) {
      lines.push(`  Symbol: ${res.symbol.value} (${res.symbol.libId})`);
    }
    return lines.join('\n');
  }

  if (res.kind === 'net') {
    const lines = [`Net ${res.net}:`];
    if (res.pins && res.pins.length > 0) {
      lines.push(`  Connected Pins (${res.pins.length}):`);
      for (const p of res.pins) {
        lines.push(`    ${p.ref}.${p.pinNumber} (${p.pinName})`);
      }
    } else {
      lines.push('  No connected component pins found.');
    }
    return lines.join('\n');
  }

  return `Explain target: ${res.target}`;
}
