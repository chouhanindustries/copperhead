/**
 * Cross-check the schematic's `lib_symbols` against the KiCad symbol libraries
 * installed on the machine (I9).
 *
 * The create pipeline currently has the model hand-author every `lib_symbols`
 * entry — pins, names, electrical types, geometry — under a `lib_id` that
 * *claims* to be a canonical KiCad part (`Device:R`, `Connector:USB_C_...`).
 * ERC only checks the net graph as drawn, so an entry whose pins silently
 * diverge from the real library part (wrong pin count, a missing shield/CC pin,
 * swapped numbers) passes every gate while being wrong. This module reads the
 * real `(symbol …)` out of the installed `.kicad_sym` and reports divergences so
 * the model — or a reviewer — can reconcile them.
 *
 * It is deliberately a *checker*, not an auto-replacer: KiCad renames symbols
 * across versions (e.g. `USB_C_Receptacle_USB2.0` became `…_14P`/`…_16P` in
 * KiCad 10), so blindly splicing by lib_id would fail on exactly the parts that
 * matter most. When the exact name is absent, we surface close candidates
 * instead of guessing.
 */

import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { parseSexp, children, child, isList, type SexpNode } from './sexp.js';

const tag = (n: SexpNode): string | null => (isList(n) && typeof n[0] === 'string' ? n[0] : null);
const atomAt = (node: SexpNode[] | undefined, idx: number): string | undefined => {
  const v = node?.[idx];
  return typeof v === 'string' ? v : undefined;
};

// KiCad has two spellings for an unnamed pin: the legacy `~` sentinel and, in
// newer library format, an empty string. They are semantically identical, so
// normalize before comparing or the check floods with phantom `~` vs "" diffs.
const normPinName = (n: string): string => (n === '~' ? '' : n);

export interface LibPin {
  number: string;
  name: string;
  /** electrical type: passive | power_in | bidirectional | input | … */
  type: string;
}

/**
 * Candidate directories holding KiCad's stock `.kicad_sym` libraries, most
 * specific first. Env overrides win (KiCad exports these), then the standard
 * install locations for Linux/macOS/Windows. Only existing dirs are returned.
 */
export async function symbolSearchDirs(env = process.env): Promise<string[]> {
  const fromEnv = [
    env.KICAD_SYMBOL_DIR,
    env.KICAD10_SYMBOL_DIR,
    env.KICAD9_SYMBOL_DIR,
    env.KICAD8_SYMBOL_DIR,
  ].filter((v): v is string => !!v);
  const defaults = [
    '/usr/share/kicad/symbols',
    '/usr/local/share/kicad/symbols',
    '/Applications/KiCad/KiCad.app/Contents/SharedSupport/symbols',
    'C:/Program Files/KiCad/share/kicad/symbols',
  ];
  const out: string[] = [];
  for (const dir of [...fromEnv, ...defaults]) {
    try {
      await access(dir);
      if (!out.includes(dir)) out.push(dir);
    } catch {
      // not present on this machine; skip
    }
  }
  return out;
}

/** Path to `<lib>.kicad_sym` in the first search dir that has it, or null. */
export async function findLibraryFile(lib: string, dirs: string[]): Promise<string | null> {
  for (const dir of dirs) {
    const p = path.join(dir, `${lib}.kicad_sym`);
    try {
      await access(p);
      return p;
    } catch {
      // try next dir
    }
  }
  return null;
}

/** Collect pins (number, name, electrical type) from a `(symbol …)` node,
 * including its nested unit sub-symbols. Same walk `libPinDefs` uses, plus the
 * electrical-type atom that pin-position parsing does not need. */
export function pinsOfSymbolNode(sym: SexpNode[]): LibPin[] {
  const pins: LibPin[] = [];
  const walk = (n: SexpNode): void => {
    if (!isList(n)) return;
    if (tag(n) === 'pin') {
      const num = atomAt(child(n, 'number'), 1);
      if (num !== undefined) {
        pins.push({
          number: num,
          name: atomAt(child(n, 'name'), 1) ?? '~',
          type: typeof n[1] === 'string' ? n[1] : '?',
        });
      }
    }
    for (const c of n) walk(c);
  };
  walk(sym);
  return pins;
}

/** The top-level `(symbol "name" …)` entries of a parsed `.kicad_sym` root. */
function librarySymbols(root: SexpNode[]): Map<string, SexpNode[]> {
  const map = new Map<string, SexpNode[]>();
  for (const sym of children(root, 'symbol')) {
    const name = atomAt(sym, 1);
    if (name) map.set(name, sym);
  }
  return map;
}

/**
 * Find an exact symbol name in other installed libraries. Vendor packages
 * commonly ship a part that the schematic initially claims belongs to a stock
 * KiCad library (for example RF_Module:ESP32-C3-MINI-1 actually lives in
 * PCM_Espressif). Searching only the claimed file leaves the model with no
 * actionable replacement even though an authoritative symbol is installed.
 *
 * This is intentionally exact-name only: fuzzy matching across hundreds of
 * libraries would produce noisy, unrelated suggestions. Same-library fuzzy
 * candidates remain available below for KiCad's ordinary rename cases.
 */
async function exactCrossLibraryCandidates(name: string, claimedLib: string, dirs: string[]): Promise<string[]> {
  const candidates: string[] = [];
  const needle = `(symbol "${name}"`;
  for (const dir of dirs) {
    let files: string[];
    try {
      files = (await readdir(dir)).filter((file) => file.endsWith('.kicad_sym'));
    } catch {
      continue;
    }
    for (const file of files) {
      const lib = file.slice(0, -'.kicad_sym'.length);
      if (!lib || lib === claimedLib) continue;
      try {
        if ((await readFile(path.join(dir, file), 'utf8')).includes(needle)) {
          candidates.push(`${lib}:${name}`);
          if (candidates.length >= 8) return candidates;
        }
      } catch {
        // One unreadable optional library must not hide candidates in others.
      }
    }
  }
  return candidates;
}

/**
 * Resolve a `lib_id` (e.g. `Device:R`) to the real library part's pins.
 * `extends` derived symbols inherit their base's pins, so we follow one such
 * link (loop-guarded). Returns the pins, or — when the exact symbol is absent —
 * the closest-named candidates so a caller can suggest the real name.
 */
export async function resolveLibrarySymbol(
  libId: string,
  dirs: string[],
): Promise<
  | { status: 'ok'; pins: LibPin[] }
  | { status: 'no-symbol'; candidates: string[] }
  | { status: 'no-library' }
> {
  const [lib, name] = libId.includes(':') ? [libId.slice(0, libId.indexOf(':')), libId.slice(libId.indexOf(':') + 1)] : ['', libId];
  const file = await findLibraryFile(lib, dirs);
  if (!file) return { status: 'no-library' };
  const root = parseSexp(await readFile(file, 'utf8'))[0];
  if (root === undefined || !isList(root)) return { status: 'no-library' };
  const symbols = librarySymbols(root);

  let current = name;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const sym = symbols.get(current);
    if (!sym) break;
    const pins = pinsOfSymbolNode(sym);
    if (pins.length) return { status: 'ok', pins };
    // no pins of its own → follow an `extends` base if present
    const base = atomAt(child(sym, 'extends'), 1);
    if (!base) return { status: 'ok', pins }; // genuinely pinless (e.g. a graphic)
    current = base;
  }

  // exact name not found: offer near matches (case-insensitive substring both ways)
  const q = name.toLowerCase();
  const candidates = [...symbols.keys()]
    .filter((k) => {
      const lk = k.toLowerCase();
      return lk.includes(q) || q.includes(lk);
    })
    .slice(0, 8);
  if (candidates.length) return { status: 'no-symbol', candidates };
  return {
    status: 'no-symbol',
    candidates: await exactCrossLibraryCandidates(name, lib, dirs),
  };
}

export interface SymbolFinding {
  libId: string;
  kind: 'no-library' | 'no-symbol' | 'pin-count' | 'pin-mismatch';
  detail: string;
}

/** A schematic lib_symbols entry: its lib_id and the pins as authored. */
function schematicLibSymbols(root: SexpNode[]): { libId: string; pins: LibPin[] }[] {
  const libs = child(root, 'lib_symbols');
  if (!libs) return [];
  return children(libs, 'symbol').map((sym) => ({
    libId: atomAt(sym, 1) ?? '',
    pins: pinsOfSymbolNode(sym),
  }));
}

/**
 * Compare every lib_symbols entry in a schematic against the installed library.
 * Returns one finding per divergence; an empty array means every resolvable
 * symbol matched. A part whose library is not installed is reported once (so
 * the model knows the check could not run for it) but never treated as a
 * mismatch — absence of the library is not evidence of wrong pins.
 */
export async function verifySchematicSymbols(
  schPath: string,
  env = process.env,
): Promise<{ findings: SymbolFinding[]; checked: number; skipped: number }> {
  const dirs = await symbolSearchDirs(env);
  const root = parseSexp(await readFile(schPath, 'utf8'))[0];
  const findings: SymbolFinding[] = [];
  if (root === undefined || !isList(root)) return { findings, checked: 0, skipped: 0 };

  let checked = 0;
  let skipped = 0;
  for (const entry of schematicLibSymbols(root)) {
    if (!entry.libId) continue;
    const resolved = await resolveLibrarySymbol(entry.libId, dirs);
    if (resolved.status === 'no-library') {
      skipped++;
      findings.push({
        libId: entry.libId,
        kind: 'no-library',
        detail: `library for "${entry.libId}" is not installed on this machine; cannot verify its pins`,
      });
      continue;
    }
    if (resolved.status === 'no-symbol') {
      findings.push({
        libId: entry.libId,
        kind: 'no-symbol',
        detail: resolved.candidates.length
          ? `"${entry.libId}" does not exist in the installed library — closest real symbols: ${resolved.candidates.join(', ')}. Use one of these lib_ids (KiCad renames symbols across versions).`
          : `"${entry.libId}" does not exist in the installed library and no close match was found; confirm the lib_id.`,
      });
      continue;
    }
    checked++;
    const real = resolved.pins;
    const authored = entry.pins;
    const realByNum = new Map(real.map((p) => [p.number, p]));
    const authByNum = new Map(authored.map((p) => [p.number, p]));
    if (real.length !== authored.length) {
      findings.push({
        libId: entry.libId,
        kind: 'pin-count',
        detail: `pin count differs: schematic has ${authored.length} pin(s) [${[...authByNum.keys()].join(',')}], the real ${entry.libId} has ${real.length} [${[...realByNum.keys()].join(',')}]`,
      });
    }
    // per-pin name/type divergence on shared pin numbers
    for (const [num, rp] of realByNum) {
      const ap = authByNum.get(num);
      if (!ap) continue; // count mismatch already reported the gap
      if (normPinName(ap.name) !== normPinName(rp.name) || ap.type !== rp.type) {
        findings.push({
          libId: entry.libId,
          kind: 'pin-mismatch',
          detail: `pin ${num}: schematic has (name "${ap.name}", ${ap.type}), real part has (name "${rp.name}", ${rp.type})`,
        });
      }
    }
  }
  return { findings, checked, skipped };
}
