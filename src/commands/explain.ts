import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { parseCanonicalTables } from '../memory/bom-table.js';
import {
  listSymbols,
  listNets,
  pinNets,
  type SchematicSymbol,
  type PinNet,
} from '../kicad/sexp.js';

export class ExplainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExplainError';
  }
}

export type ExplainResult =
  | {
      target: string;
      kind: 'refdes';
      symbol: SchematicSymbol;
      pins: PinNet[];
      bomRationale?: string;
    }
  | {
      target: string;
      kind: 'pin';
      pins: [PinNet];
      symbol?: SchematicSymbol;
    }
  | {
      target: string;
      kind: 'net';
      net: string;
      pins: PinNet[];
    };

async function tryReadBomRationale(
  repoRoot: string,
  docsDir: string,
  ref: string,
): Promise<string | undefined> {
  const p = path.join(repoRoot, docsDir, 'BOM.md');
  if (!existsSync(p)) return undefined;

  try {
    const text = await readFile(p, 'utf8');
    const refUpper = ref.toUpperCase();

    for (const { header, rows } of parseCanonicalTables(text)) {
      const refIndex = header.cells.findIndex((c) => /^refdes$/i.test(c));
      const rationaleIndex = header.cells.findIndex((c) =>
        /^rationale$/i.test(c),
      );

      if (refIndex < 0 || rationaleIndex < 0) continue;

      const hit = rows.find(
        (r) => r.cells[refIndex]?.toUpperCase() === refUpper,
      );

      if (hit) {
        return hit.cells[rationaleIndex] || undefined;
      }
    }
  } catch {
    // Optional docs lookup - ignore read errors
  }

  return undefined;
}

export async function runExplain(
  repoRoot: string,
  target: string,
): Promise<ExplainResult> {
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

  // 1. Try Refdes match first.
  const matchedSymbol = symbols.find(
    (s) => s.ref.toLowerCase() === targetLower,
  );
  if (matchedSymbol) {
    const symbolPins = allPinNets.filter(
      (p) => p.ref.toLowerCase() === targetLower,
    );
    const bomRationale = await tryReadBomRationale(
      repoRoot,
      config.docs,
      matchedSymbol.ref,
    );
    return {
      target,
      kind: 'refdes',
      symbol: matchedSymbol,
      pins: symbolPins,
      bomRationale,
    };
  }

  // 2. Try Net match before interpreting dotted targets as pins.
  const isKnownNet = allNets.some((n) => n.toLowerCase() === targetLower);
  const netPins = allPinNets.filter(
    (p) => p.net && p.net.toLowerCase() === targetLower,
  );
  if (isKnownNet || netPins.length > 0) {
    const canonicalNet =
      allNets.find((n) => n.toLowerCase() === targetLower) ?? targetTrimmed;
    return {
      target,
      kind: 'net',
      net: canonicalNet,
      pins: netPins,
    };
  }

  const targetParts = targetTrimmed.split('.');

  if (targetParts.length > 2) {
    throw new ExplainError(
      `invalid pin target "${target}"; expected <refdes>.<pin>`,
    );
  }

  // 3. Try Pin match ("U1.1" or "U1.GPIO14")
  if (targetTrimmed.includes('.')) {
    const [refPart, pinPart] = targetParts;

    if (refPart && pinPart) {
      const refLower = refPart.toLowerCase();
      const pinLower = pinPart.toLowerCase();

      const matchedPin = allPinNets.find(
        (p) =>
          p.ref.toLowerCase() === refLower &&
          (p.pinNumber.toLowerCase() === pinLower ||
            p.pinName.toLowerCase() === pinLower),
      );

      if (matchedPin) {
        const parentSymbol = symbols.find(
          (s) => s.ref.toLowerCase() === refLower,
        );

        return {
          target,
          kind: 'pin',
          pins: [matchedPin],
          symbol: parentSymbol,
        };
      }
    }
  }

  throw new ExplainError(`target "${target}" not found in schematic`);
}

export function formatExplainReport(res: ExplainResult): string {
  if (res.kind === 'refdes') {
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

    if (res.pins.length > 0) {
      lines.push(`  Pins (${res.pins.length}):`);
      for (const p of res.pins) {
        lines.push(
          `    ${p.pinNumber} (${p.pinName}): ${p.net || '(unconnected)'}`,
        );
      }
    }

    return lines.join('\n');
  } else if (res.kind === 'pin') {
    const [p] = res.pins;

    const lines = [
      `Pin ${p.ref}.${p.pinNumber} (${p.pinName}):`,
      `  Net: ${p.net || '(unconnected)'}`,
    ];

    if (res.symbol) {
      lines.push(`  Symbol: ${res.symbol.value} (${res.symbol.libId})`);
    }

    return lines.join('\n');
  } else {
    // res.kind === 'net'
    const lines = [`Net ${res.net}:`];

    if (res.pins.length > 0) {
      lines.push(`  Connected Pins (${res.pins.length}):`);
      for (const p of res.pins) {
        lines.push(`    ${p.ref}.${p.pinNumber} (${p.pinName})`);
      }
    } else {
      lines.push('  No connected component pins found.');
    }

    return lines.join('\n');
  }
}
