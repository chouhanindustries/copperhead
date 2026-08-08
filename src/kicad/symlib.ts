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
 *
 * @param winRoot test seam for the Windows `C:\Program Files\KiCad` root;
 *   defaults to the real path. Without this, the Windows version-directory
 *   discovery below can only be exercised on an actual Windows machine with
 *   KiCad installed at the default location.
 */
export async function symbolSearchDirs(env = process.env, winRoot = 'C:/Program Files/KiCad'): Promise<string[]> {
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
    // Windows installs under a version-numbered directory
    // (C:\Program Files\KiCad\10.0\...), unlike Linux/macOS, so there is no
    // single fixed path here. Discovered below instead.
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
  // Windows: KiCad's own installer picks the version directory
  // (`10.0`, `9.0`, `8.0`, ...), so no fixed path is ever correct. List
  // `C:\Program Files\KiCad` and check each version folder instead. Sorted
  // descending so a machine with more than one version prefers the newest.
  // Skipped entirely when an env override is set: "env overrides win" means
  // exactly that, not "env overrides win, plus whatever else this discovers"
  // — a caller pointing KICAD_SYMBOL_DIR at an isolated directory (tests, a
  // pinned library set) must get only that directory back.
  const kicadRoot = winRoot;
  try {
    if (fromEnv.length > 0) throw new Error('env override present; skip Windows auto-discovery');
    const entries = await readdir(kicadRoot, { withFileTypes: true });
    const versions = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      const dir = `${kicadRoot}/${version}/share/kicad/symbols`;
      try {
        await access(dir);
        if (!out.includes(dir)) out.push(dir);
      } catch {
        // this version folder has no symbols dir; skip
      }
    }
  } catch {
    // C:\Program Files\KiCad doesn't exist on this machine (not Windows, or KiCad not installed here); skip
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

/** Every `<name>.kicad_sym` file across the search dirs, first occurrence wins per name. */
async function allLibraryFiles(dirs: string[]): Promise<{ lib: string; file: string }[]> {
  const seen = new Set<string>();
  const out: { lib: string; file: string }[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.kicad_sym')) continue;
      const lib = entry.slice(0, -'.kicad_sym'.length);
      if (seen.has(lib)) continue;
      seen.add(lib);
      out.push({ lib, file: path.join(dir, entry) });
    }
  }
  return out;
}

export interface CrossLibraryMatch {
  lib: string;
  /** The symbol name actually found (may differ from the query on a fuzzy hit,
   * e.g. `SHT4x` for a query of `SHT40`) — the suggested lib_id must be built
   * from this, never from the caller's original query, or a fuzzy suggestion
   * points at a lib_id that does not exist. */
  name: string;
  /** true when `name` matched exactly; false for a fuzzy hit. */
  exact: boolean;
}

/** Cross-library matches, most-caller-useful first. */
const CROSS_LIBRARY_CAP = 8;

/**
 * Reduce raw cross-library matches to the lib_ids worth suggesting: any exact
 * hit is unambiguous evidence and crowds out fuzzy noise entirely (a query
 * with one exact match and several fuzzy near-misses must report only the
 * exact one, never a mix); with no exact hit, fuzzy candidates are offered but
 * capped, matching the cap the same-file candidate list already uses, so a
 * short or generic query (a single letter, a common prefix) cannot return
 * dozens of unrelated libraries in one finding.
 */
export function crossLibraryIds(matches: CrossLibraryMatch[]): string[] {
  const exact = matches.filter((m) => m.exact);
  const chosen = exact.length ? exact : matches;
  return chosen.slice(0, CROSS_LIBRARY_CAP).map((m) => `${m.lib}:${m.name}`);
}

/** Levenshtein edit distance, capped: returns `cap + 1` once the true distance
 * would exceed `cap`, so a caller doing a cheap "is this close enough" check
 * never pays for the full O(n·m) table on two names that are obviously
 * unrelated. */
function editDistanceWithin(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1; // whole row exceeded cap: no cell can recover
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * A part is unresolvable at its guessed `lib_id`, but the guess itself is often
 * right about the *part*, just wrong about which stock file it lives in (a
 * chip's library nickname is not derivable from its part number). Rather than
 * fail outright, check every other discovered `.kicad_sym` for a symbol with
 * this exact name; when none matches exactly, fall back to the same
 * closest-candidate substring heuristic `resolveLibrarySymbol` already uses
 * within one file, just applied across all of them.
 *
 * Returns matches sorted exact-first; the caller decides what "found" means
 * (one exact hit resolves unambiguously, several means the agent must pick).
 */
export async function findSymbolAcrossLibraries(
  name: string,
  dirs: string[],
  excludeLib?: string,
): Promise<CrossLibraryMatch[]> {
  const files = await allLibraryFiles(dirs);
  const q = name.toLowerCase();
  const exact: CrossLibraryMatch[] = [];
  const fuzzy: CrossLibraryMatch[] = [];
  for (const { lib, file } of files) {
    // `excludeLib` is only known not to hold this *exact* name; it can still
    // hold the near-miss the caller actually wants (SHT40 guessed in
    // Sensor_Humidity, where the real symbol is SHT4x). Skip its exact check,
    // never its fuzzy one.
    const skipExact = lib === excludeLib;
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const names = [...text.matchAll(/^\s*\(symbol\s+"([^"]+)"/gm)].map((m) => m[1]!);
    if (!skipExact && names.includes(name)) {
      exact.push({ lib, name, exact: true });
      continue;
    }
    // The "does the query contain the library name" direction is only
    // meaningful for a reasonably specific name (>= 3 chars): a stock library
    // is full of single-letter generics ("R", "C", "L", "D", "U", "Q"), and
    // "does <any part number> contain the letter R" is true for nearly
    // everything, which would fuzzy-match almost any query against them.
    const MIN_SHORT_NAME_LEN = 3;
    // Substring alone misses the most common real near-miss: a datasheet part
    // number against a library's family name, differing mid-string rather than
    // at either end (SHT40 vs SHT4x, where `x` stands for "any variant").
    // Neither contains the other, so only edit distance catches it. Kept tight
    // (1 edit, and only for names long enough that one edit is still
    // distinctive) so TPS22860 does not silently match TPS22810 — a different
    // real part, which is exactly the wrong-part failure this tool must not
    // introduce.
    const MIN_EDIT_MATCH_LEN = 5;
    // The matched candidate string, not just whether one exists: a fuzzy hit
    // must report the real symbol name (`n`) so the caller can build a lib_id
    // that actually resolves. Suggesting `${lib}:${query}` back would name a
    // part that was never found in that library — the exact regression this
    // fuzzy path exists to avoid repeating.
    const fuzzyHit = names.find((n) => {
      const lower = n.toLowerCase();
      if (lower.includes(q)) return true;
      if (lower.length >= MIN_SHORT_NAME_LEN && q.includes(lower)) return true;
      return (
        q.length >= MIN_EDIT_MATCH_LEN &&
        lower.length >= MIN_EDIT_MATCH_LEN &&
        editDistanceWithin(q, lower, 1) <= 1
      );
    });
    if (fuzzyHit) {
      fuzzy.push({ lib, name: fuzzyHit, exact: false });
    }
  }
  return [...exact, ...fuzzy];
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
  | { status: 'found-elsewhere'; libIds: string[] }
> {
  const [lib, name] = libId.includes(':') ? [libId.slice(0, libId.indexOf(':')), libId.slice(libId.indexOf(':') + 1)] : ['', libId];
  const file = await findLibraryFile(lib, dirs);
  if (!file) {
    const elsewhere = await findSymbolAcrossLibraries(name, dirs, lib);
    if (elsewhere.length) return { status: 'found-elsewhere', libIds: crossLibraryIds(elsewhere) };
    return { status: 'no-library' };
  }
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

  // Evidence, strongest first: an exact match in a different library is
  // unambiguous (the file name was the mistake, not the part), so it outranks
  // even a same-file substring guess — the guessed library is often full of
  // single-letter generics ("R", "C", "L") that trivially substring-match
  // almost any query, and would otherwise silently outrank a real answer.
  // Same-file candidates come next: the caller named the right file and
  // mistyped the part, which is stronger evidence than a fuzzy guess in a
  // library the caller never named. A cross-library fuzzy hit is last resort.
  const elsewhere = await findSymbolAcrossLibraries(name, dirs, lib);
  const exactElsewhere = elsewhere.filter((m) => m.exact);
  if (exactElsewhere.length) return { status: 'found-elsewhere', libIds: crossLibraryIds(exactElsewhere) };

  const q = name.toLowerCase();
  const candidates = [...symbols.keys()]
    .filter((k) => {
      const lk = k.toLowerCase();
      return lk.includes(q) || q.includes(lk);
    })
    .slice(0, 8);
  if (candidates.length) return { status: 'no-symbol', candidates };

  if (elsewhere.length) return { status: 'found-elsewhere', libIds: crossLibraryIds(elsewhere) };

  return { status: 'no-symbol', candidates };
}

export interface SymbolFinding {
  libId: string;
  /** 'wrong-library' is a real issue to reconcile (an actionable correction),
   * unlike 'no-library' (nothing could be checked) — keeping it distinct means
   * a caller's issue count does not silently drop it into neither bucket. */
  kind: 'no-library' | 'no-symbol' | 'wrong-library' | 'pin-count' | 'pin-mismatch';
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

// Must match SYM_CACHE_DIR in ../kicad/draft/symsource.ts. Not imported from
// there: symsource.ts already imports from this module, and the constant is
// stable enough (it is part of the on-disk project layout, D4) that a literal
// here is safer than risking a cycle.
const VENDOR_CACHE_DIR = 'sym-lib-cache';

/**
 * Library nicknames the project has vendored into `sym-lib-cache/` (the
 * drafting engine's own generated power symbols, or a stock symbol it copied
 * in on first use). A nickname absent from every installed search dir is not
 * necessarily a *wrong* library: it may be deliberately absent, because the
 * project vendors it instead. Returns an empty set (never throws) when the
 * directory does not exist or is unreadable, so a caller that cannot check
 * simply treats nothing as vendored rather than failing the whole check.
 */
async function vendoredLibNames(repoRoot: string): Promise<Set<string>> {
  try {
    const entries = await readdir(path.join(repoRoot, VENDOR_CACHE_DIR));
    return new Set(entries.filter((e) => e.endsWith('.kicad_sym')).map((e) => e.slice(0, -'.kicad_sym'.length)));
  } catch {
    return new Set();
  }
}

/**
 * Compare every lib_symbols entry in a schematic against the installed library.
 * Returns one finding per divergence; an empty array means every resolvable
 * symbol matched. A part whose library is not installed is reported once (so
 * the model knows the check could not run for it) but never treated as a
 * mismatch — absence of the library is not evidence of wrong pins.
 *
 * @param repoRoot project root, so a nickname the project deliberately vendors
 *   (the drafting engine's generated power symbols, `copperhead_power`) is
 *   never reported as "wrong library, use X instead": that library is absent
 *   from the search dirs on purpose, and telling the agent to switch away from
 *   its own vendored symbols would either churn for nothing or break the
 *   deterministic-vendoring guarantee (design D4). Optional for callers that
 *   cannot supply it (older call sites, ad hoc checks): those simply cannot
 *   distinguish "deliberately vendored" from "genuinely wrong", so they get
 *   the plain `no-library` treatment for every unresolvable nickname, which
 *   is always safe, just less specific for the genuinely-wrong case.
 */
export async function verifySchematicSymbols(
  schPath: string,
  env = process.env,
  repoRoot?: string,
): Promise<{ findings: SymbolFinding[]; checked: number; skipped: number }> {
  const dirs = await symbolSearchDirs(env);
  const vendored = repoRoot ? await vendoredLibNames(repoRoot) : new Set<string>();
  const root = parseSexp(await readFile(schPath, 'utf8'))[0];
  const findings: SymbolFinding[] = [];
  if (root === undefined || !isList(root)) return { findings, checked: 0, skipped: 0 };

  let checked = 0;
  let skipped = 0;
  for (const entry of schematicLibSymbols(root)) {
    if (!entry.libId) continue;
    const guessedLib = entry.libId.includes(':') ? entry.libId.slice(0, entry.libId.indexOf(':')) : '';
    const resolved = vendored.has(guessedLib) ? ({ status: 'no-library' } as const) : await resolveLibrarySymbol(entry.libId, dirs);
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
    if (resolved.status === 'found-elsewhere') {
      findings.push({
        libId: entry.libId,
        kind: 'wrong-library',
        detail: `"${entry.libId}" names the wrong library, not the wrong part: use ${resolved.libIds.join(' or ')} instead.`,
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
