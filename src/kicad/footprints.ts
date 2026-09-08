/**
 * Deterministic schematic-to-board footprint population.
 *
 * Footprint bodies are copied from installed `.kicad_mod` files and patched as
 * text. The s-expression reader remains read-only: this module never
 * serializes a parsed KiCad file, and it does not place tracks or alter the
 * existing board outline.
 */

import { access, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listSymbols, pinNets } from './sexp.js';
import { knum, uuidv5 } from './emit.js';

export interface FootprintPlacement {
  ref: string;
  x: number;
  y: number;
  rotation?: number;
}

export interface PopulateBoardOptions {
  repoRoot: string;
  schematic: string;
  board: string;
  placements: FootprintPlacement[];
  /** Parent directories containing `Lib.pretty/Name.kicad_mod`; test seam. */
  footprintDirs?: string[];
}

export interface PopulateBoardResult {
  placed: string[];
}

const q = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export async function footprintSearchDirs(env = process.env): Promise<string[]> {
  const overrides = [
    env.KICAD_FOOTPRINT_DIR,
    env.KICAD10_FOOTPRINT_DIR,
    env.KICAD9_FOOTPRINT_DIR,
    env.KICAD8_FOOTPRINT_DIR,
  ].filter((v): v is string => !!v);
  const defaults = [
    '/usr/share/kicad/footprints',
    '/usr/local/share/kicad/footprints',
    '/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints',
  ];
  const out: string[] = [];
  for (const dir of overrides.length ? overrides : defaults) {
    try {
      await access(dir);
      if (!out.includes(dir)) out.push(dir);
    } catch {
      // An unavailable default is normal on another platform.
    }
  }
  return out;
}

/**
 * Search installed footprint names without turning user input into a path.
 * Exact normalized names rank first, then prefixes, then token matches.
 */
export async function searchInstalledFootprints(
  query: string,
  dirs?: string[],
  cap = 50,
): Promise<string[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const roots = dirs ?? (await footprintSearchDirs());
  const limit = Math.min(50, Math.max(1, Math.floor(cap)));
  const normalize = (value: string): string => value.toLocaleLowerCase('en').replace(/[^a-z0-9]+/g, '');
  const normalizedQuery = normalize(trimmed);
  if (!normalizedQuery) return [];
  const tokens = trimmed
    .toLocaleLowerCase('en')
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
  const hits: { libId: string; rank: number }[] = [];

  for (const root of roots) {
    let libraries: import('node:fs').Dirent[];
    try {
      libraries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const library of libraries) {
      if (!library.isDirectory() || !library.name.endsWith('.pretty')) continue;
      const lib = library.name.slice(0, -'.pretty'.length);
      let files: import('node:fs').Dirent[];
      try {
        files = await readdir(path.join(root, library.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.kicad_mod')) continue;
        const name = file.name.slice(0, -'.kicad_mod'.length);
        const normalizedName = normalize(name);
        const normalizedId = normalize(`${lib}:${name}`);
        const tokenMatch = tokens.length > 0 && tokens.every((token) => normalizedId.includes(normalize(token)));
        if (!normalizedId.includes(normalizedQuery) && !tokenMatch) continue;
        const rank = normalizedName === normalizedQuery ? 0 : normalizedName.startsWith(normalizedQuery) ? 1 : 2;
        hits.push({ libId: `${lib}:${name}`, rank });
      }
    }
  }
  hits.sort((a, b) => a.rank - b.rank || a.libId.localeCompare(b.libId));
  return [...new Set(hits.map((hit) => hit.libId))].slice(0, limit);
}

async function resolveFootprint(libId: string, dirs: string[]): Promise<string | null> {
  const colon = libId.indexOf(':');
  if (colon <= 0 || colon === libId.length - 1) return null;
  const lib = libId.slice(0, colon);
  const name = libId.slice(colon + 1);
  if (!/^[A-Za-z0-9_.+-]+$/.test(lib) || !/^[A-Za-z0-9_,.+-]+$/.test(name)) return null;
  for (const dir of dirs) {
    const candidate = path.join(dir, `${lib}.pretty`, `${name}.kicad_mod`);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep searching the configured roots.
    }
  }
  return null;
}

/** Balanced block starting at `(`, respecting quoted strings. */
function blockEnd(text: string, start: number): number {
  let depth = 0;
  let quoted = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  throw new Error('unbalanced footprint source');
}

function blocksNamed(text: string, name: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  const needle = `(${name}`;
  for (let from = 0; ; ) {
    const start = text.indexOf(needle, from);
    if (start < 0) return out;
    const after = text[start + needle.length];
    if (after !== ' ' && after !== '\t' && after !== '\n' && after !== '\r') {
      from = start + needle.length;
      continue;
    }
    const end = blockEnd(text, start);
    out.push({ start, end, text: text.slice(start, end) });
    from = end;
  }
}

function boardRefs(board: string): string[] {
  return blocksNamed(board, 'footprint').flatMap((b) => {
    const match = /\(property\s+"Reference"\s+"((?:[^"\\]|\\.)*)"/.exec(b.text);
    return match?.[1] ? [match[1]] : [];
  });
}

function replaceProperty(source: string, property: 'Reference' | 'Value', value: string): string {
  const pattern = new RegExp(`(\\(property\\s+"${property}"\\s+)"(?:[^"\\\\]|\\\\.)*"`);
  if (!pattern.test(source)) throw new Error(`footprint source has no ${property} property`);
  return source.replace(pattern, `$1${q(value).replace(/\$/g, '$$$$')}`);
}

/**
 * KiCad stores child-item angles in board coordinates even though their x/y
 * positions remain local to the footprint. Rotating only the footprint-level
 * `(at …)` therefore makes the instance differ from its library source. Add
 * the instance rotation to every library-local `(at x y [angle])` before the
 * footprint-level position is inserted.
 */
function rotateLocalAtAngles(source: string, rotation: number): string {
  if (rotation === 0) return source;
  const number = '[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?';
  const at = new RegExp(`\\(at\\s+(${number})\\s+(${number})(?:\\s+(${number}))?\\)`, 'g');
  return source.replace(at, (_whole, x: string, y: string, angle: string | undefined) => {
    const turned = ((Number(angle ?? 0) + rotation) % 360 + 360) % 360;
    return `(at ${x} ${y} ${knum(turned)})`;
  });
}

function instantiateFootprint(
  source: string,
  libId: string,
  ref: string,
  value: string,
  placement: FootprintPlacement,
  pinToNet: Map<string, { id: number; name: string } | null>,
): string {
  let out = source.trim();
  out = out.replace(/^(\(footprint\s+)"(?:[^"\\]|\\.)*"/, `$1${q(libId).replace(/\$/g, '$$$$')}`);
  if (!out.startsWith('(footprint ')) throw new Error(`unparseable footprint source for ${libId}`);
  // Library-only metadata is not legal inside a board's footprint instance.
  out = out.replace(/^\s*\((?:version|generator|generator_version)\b[^\n]*\)\s*$/gm, '');
  out = replaceProperty(out, 'Reference', ref);
  out = replaceProperty(out, 'Value', value);

  const rotation = placement.rotation ?? 0;
  out = rotateLocalAtAngles(out, rotation);

  const layer = /\n([ \t]*)\(layer\s+"[^"]+"\)/.exec(out);
  if (!layer || layer.index === undefined) throw new Error(`footprint source for ${libId} has no layer`);
  const indent = layer[1] ?? '\t';
  const instanceFields = `\n${indent}(uuid ${q(uuidv5(`pcb/footprint/${ref}`))})\n${indent}(at ${knum(placement.x)} ${knum(placement.y)} ${knum(rotation)})`;
  const layerEnd = layer.index + layer[0].length;
  out = out.slice(0, layerEnd) + instanceFields + out.slice(layerEnd);

  const pads = blocksNamed(out, 'pad');
  const padNumbers = new Set<string>();
  for (let i = pads.length - 1; i >= 0; i--) {
    const pad = pads[i]!;
    const number = /^\(pad\s+"((?:[^"\\]|\\.)*)"/.exec(pad.text)?.[1];
    if (number === undefined || number === '') continue; // mechanical NPTH
    padNumbers.add(number);
    if (!pinToNet.has(number)) throw new Error(`${ref}: footprint ${libId} pad ${number} has no schematic pin mapping`);
    const net = pinToNet.get(number);
    if (!net) continue; // intentional schematic no-connect
    if (/\(net\s+\d+\s+"/.test(pad.text)) throw new Error(`${ref}: library footprint ${libId} unexpectedly carries a net`);
    const padIndent = /\n([ \t]+)\S/.exec(pad.text)?.[1] ?? '\t\t';
    const replacement = `${pad.text.slice(0, -1)}\n${padIndent}(net ${net.id} ${q(net.name)})\n${padIndent.slice(0, Math.max(0, padIndent.length - 1))})`;
    out = out.slice(0, pad.start) + replacement + out.slice(pad.end);
  }
  for (const pin of pinToNet.keys()) {
    if (!padNumbers.has(pin)) throw new Error(`${ref}: schematic pin ${pin} has no pad in footprint ${libId}`);
  }

  let uuidIndex = 0;
  out = out.replace(/\(uuid\s+"?[0-9a-fA-F-]+"?\)/g, () => `(uuid ${q(uuidv5(`pcb/footprint/${ref}/uuid/${uuidIndex++}`))})`);
  return out
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => `\t${line}`)
    .join('\n');
}

/**
 * Populate requested footprint instances from the schematic and installed
 * libraries. Every source and pin mapping is validated before the board is
 * written; failure therefore leaves the original bytes untouched.
 */
export async function populateBoardFromSchematic(opts: PopulateBoardOptions): Promise<PopulateBoardResult> {
  const schematicPath = path.join(opts.repoRoot, opts.schematic);
  const boardPath = path.join(opts.repoRoot, opts.board);
  const [symbols, pins, board, dirs] = await Promise.all([
    listSymbols(schematicPath),
    pinNets(schematicPath),
    readFile(boardPath, 'utf8'),
    opts.footprintDirs ? Promise.resolve(opts.footprintDirs) : footprintSearchDirs(),
  ]);
  if (!opts.placements.length) throw new Error('placements must contain at least one footprint');

  const placementRefs = new Set<string>();
  for (const p of opts.placements) {
    if (!p.ref || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.rotation ?? 0)) {
      throw new Error(`invalid footprint placement for ${p.ref || '(empty ref)'}`);
    }
    if (placementRefs.has(p.ref)) throw new Error(`duplicate footprint placement ref ${p.ref}`);
    placementRefs.add(p.ref);
  }
  const existing = new Set(boardRefs(board));
  for (const ref of placementRefs) if (existing.has(ref)) throw new Error(`board already contains footprint ${ref}`);

  const symbolsByRef = new Map<string, (typeof symbols)[number][]>();
  for (const symbol of symbols) symbolsByRef.set(symbol.ref, [...(symbolsByRef.get(symbol.ref) ?? []), symbol]);
  const pinRowsByRef = new Map<string, typeof pins>();
  for (const pin of pins) pinRowsByRef.set(pin.ref, [...(pinRowsByRef.get(pin.ref) ?? []), pin]);

  const neededNetNames = new Set<string>();
  for (const p of opts.placements) for (const pin of pinRowsByRef.get(p.ref) ?? []) if (pin.net) neededNetNames.add(pin.net);
  const netByName = new Map<string, number>();
  let maxNetId = 0;
  for (const match of board.matchAll(/\(net\s+(\d+)\s+"((?:[^"\\]|\\.)*)"\)/g)) {
    const id = Number(match[1]);
    const name = match[2]!;
    if (netByName.has(name) && netByName.get(name) !== id) throw new Error(`board has ambiguous net name ${name}`);
    netByName.set(name, id);
    maxNetId = Math.max(maxNetId, id);
  }
  const newNets: { id: number; name: string }[] = [];
  for (const name of [...neededNetNames].sort()) {
    if (!netByName.has(name)) {
      const id = ++maxNetId;
      netByName.set(name, id);
      newNets.push({ id, name });
    }
  }

  const instances: string[] = [];
  for (const placement of opts.placements) {
    const matches = symbolsByRef.get(placement.ref) ?? [];
    if (matches.length !== 1) {
      throw new Error(matches.length ? `schematic ref ${placement.ref} is ambiguous` : `schematic has no ref ${placement.ref}`);
    }
    const symbol = matches[0]!;
    if (!symbol.footprint) throw new Error(`${placement.ref}: schematic has no footprint assignment`);
    const file = await resolveFootprint(symbol.footprint, dirs);
    if (!file) throw new Error(`${placement.ref}: installed footprint ${symbol.footprint} was not found`);
    const pinToNet = new Map<string, { id: number; name: string } | null>();
    for (const pin of pinRowsByRef.get(placement.ref) ?? []) {
      if (pinToNet.has(pin.pinNumber)) throw new Error(`${placement.ref}: schematic pin ${pin.pinNumber} is ambiguous`);
      pinToNet.set(pin.pinNumber, pin.net ? { id: netByName.get(pin.net)!, name: pin.net } : null);
    }
    instances.push(
      instantiateFootprint(await readFile(file, 'utf8'), symbol.footprint, placement.ref, symbol.value, placement, pinToNet),
    );
  }

  const trimmedEnd = board.trimEnd();
  const rootClose = trimmedEnd.length - 1;
  if (rootClose < 0 || board[rootClose] !== ')') throw new Error('board has no root closing anchor');
  // KiCad writes declarations before placed/drawn board objects. Prefer that
  // stable top-level anchor while still accepting a compact one-line fixture.
  const objectAnchor = /^[ \t]*\((?:footprint|gr_[A-Za-z0-9_]+|segment|arc|via|zone|group)\b/m.exec(board);
  const insertionAt = objectAnchor?.index ?? rootClose;
  const netText = newNets.map((n) => `\t(net ${n.id} ${q(n.name)})`).join('\n');
  const insertion = `${netText ? `\n${netText}` : ''}\n${instances.join('\n')}\n`;
  const next = board.slice(0, insertionAt) + insertion + board.slice(insertionAt);
  const temp = path.join(path.dirname(boardPath), `.${path.basename(boardPath)}.copperhead-${process.pid}.tmp`);
  try {
    await writeFile(temp, next, 'utf8');
    await rename(temp, boardPath);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
  return { placed: opts.placements.map((p) => p.ref) };
}
