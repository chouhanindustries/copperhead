/**
 * Read-only access to the KiCad footprint libraries installed on this machine.
 *
 * The symbol side has `symlib.ts`; this is its board-side twin. Footprints live
 * one-per-file as `<Library>.pretty/<Name>.kicad_mod`, so a `lib_id` of
 * `Package_SO:SOIC-8_3.9x4.9mm_P1.27mm` resolves to a single file whose text is
 * exactly what a `.kicad_pcb` embeds. The layout stage needs this before it can
 * place anything: pad counts, pad numbers, and pad geometry must be transcribed
 * from the library, never invented (a fabricated pad map is DRC-clean and
 * physically wrong).
 */
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** Where footprint libraries live: env overrides first, then standard installs. */
export async function footprintSearchDirs(env = process.env): Promise<string[]> {
  const fromEnv = [
    env.KICAD_FOOTPRINT_DIR,
    env.KICAD10_FOOTPRINT_DIR,
    env.KICAD9_FOOTPRINT_DIR,
    env.KICAD8_FOOTPRINT_DIR,
  ].filter((v): v is string => !!v);
  const defaults = [
    '/usr/share/kicad/footprints',
    '/usr/local/share/kicad/footprints',
    '/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints',
    'C:/Program Files/KiCad/share/kicad/footprints',
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

/** Path to `<lib>.pretty/<name>.kicad_mod` in the first dir that has it. */
export async function findFootprintFile(
  lib: string,
  name: string,
  dirs: string[],
): Promise<string | null> {
  for (const dir of dirs) {
    const p = path.join(dir, `${lib}.pretty`, `${name}.kicad_mod`);
    try {
      await access(p);
      return p;
    } catch {
      // try next dir
    }
  }
  return null;
}

/** Pad numbers declared by a footprint, in file order (duplicates kept: a
 *  thermal pad often repeats a number across several pad entries). */
export function padNumbers(modText: string): string[] {
  const pads: string[] = [];
  const re = /\(pad\s+("(?:[^"\\]|\\.)*"|[^\s()]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(modText)) !== null) {
    const raw = m[1];
    if (raw !== undefined) pads.push(raw.replace(/^"|"$/g, ''));
  }
  return pads;
}

/** Closest footprint names in a library, for a not-found suggestion list. */
async function candidatesIn(lib: string, name: string, dirs: string[]): Promise<string[]> {
  for (const dir of dirs) {
    try {
      const files = await readdir(path.join(dir, `${lib}.pretty`));
      const stems = files.filter((f) => f.endsWith('.kicad_mod')).map((f) => f.slice(0, -10));
      const needle = name.toLowerCase();
      const head = needle.split(/[-_]/)[0] ?? needle;
      const scored = stems
        .map((s) => {
          const t = s.toLowerCase();
          let score = 0;
          if (t === needle) score = 100;
          else if (t.startsWith(needle) || needle.startsWith(t)) score = 60;
          else if (head.length >= 3 && t.includes(head)) score = 30;
          return { s, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      return scored.slice(0, 6).map((x) => x.s);
    } catch {
      // library dir not here; try next
    }
  }
  return [];
}

export type FootprintLookup =
  | { status: 'ok'; file: string; text: string; pads: string[] }
  | { status: 'no-footprint'; candidates: string[] }
  | { status: 'no-library' };

/** Resolve `Library:Footprint` to the real `.kicad_mod` text and pad list. */
export async function resolveFootprint(libId: string, dirs: string[]): Promise<FootprintLookup> {
  const i = libId.indexOf(':');
  const lib = i >= 0 ? libId.slice(0, i) : '';
  const name = i >= 0 ? libId.slice(i + 1) : libId;
  const file = await findFootprintFile(lib, name, dirs);
  if (!file) {
    // Distinguish "library absent" from "footprint absent in that library".
    let libExists = false;
    for (const dir of dirs) {
      try {
        await access(path.join(dir, `${lib}.pretty`));
        libExists = true;
        break;
      } catch {
        // keep looking
      }
    }
    if (!libExists) return { status: 'no-library' };
    return { status: 'no-footprint', candidates: await candidatesIn(lib, name, dirs) };
  }
  const text = await readFile(file, 'utf8');
  return { status: 'ok', file, text, pads: padNumbers(text) };
}
