/**
 * The stage-4 entry pin dossier: every BOM part resolved against the installed
 * KiCad libraries, rendered as a prompt block, so the schematic agent starts
 * with the pin facts it would otherwise spend turns reconstructing.
 *
 * The BOM is frozen when stage 4 starts, which makes this computable before the
 * first agent turn — the same insight `symbolAvailabilityFacts` applies at
 * recovery time, moved to entry. Like that block, coverage is stated rather
 * than implied: parts past the size cap are named as NOT INCLUDED and parts a
 * probe error skipped are named as UNRESOLVED, never silently dropped, because
 * absence from the dossier must never read as absence from the libraries.
 *
 * Advisory only. It changes prompt content, not gates: a missing BOM, an
 * unreadable library, or any error degrades to an empty string and the stage
 * runs exactly as it did before this block existed.
 */

import { parseBomTable } from '../memory/bom-table.js';
import {
  resolveLibrarySymbol,
  searchInstalledSymbols,
  listInstalledLibraries,
  comparePinNumbers,
  type LibPin,
} from './symlib.js';

/** R/C/L refdes (with optional multi-part suffix like R12A) draw from their
 * canonical `Device:*` symbols; a two-pin table per resistor is noise. */
const PASSIVE_REFDES = /^[RCL]\d+[A-Za-z]?$/i;

/** `1=PE2/bidirectional 2(passive) …` — name omitted when the library leaves
 * the pin unnamed (`~` or empty), since `1=~/passive` reads as line noise. */
function pinTable(pins: LibPin[]): string {
  return [...pins]
    .sort((a, b) => comparePinNumbers(a.number, b.number))
    .map((p) => {
      const name = p.name === '~' ? '' : p.name;
      return name ? `${p.number}=${name}/${p.type}` : `${p.number}(${p.type})`;
    })
    .join(' ');
}

/** Render `prefix + as many names as fit + suffix` within `budget` chars; the
 * tail that does not fit becomes "…and N more", so the trailer itself can
 * never blow the size cap it exists to disclose. */
function boundedList(prefix: string, names: string[], suffix: string, budget: number): string {
  let line = '';
  for (let i = 0; i < names.length; i++) {
    const remaining = names.length - i;
    const sep = i === 0 ? '' : '; ';
    const tail = `…and ${remaining} more`;
    const candidate = `${line}${sep}${names[i]}`;
    // Reserve room for the worst-case continuation marker after this name.
    if (prefix.length + candidate.length + tail.length + 2 + suffix.length > budget) {
      return `${prefix}${line ? `${line}; ` : ''}…and ${remaining} more${suffix}`;
    }
    line = candidate;
  }
  return `${prefix}${line}${suffix}`;
}

export interface DossierOptions {
  /** candidate lib_ids fetched per part */
  searchCap?: number;
  /** bound on the complete rendered block, disclosure lines included */
  maxChars?: number;
}

/**
 * Render the dossier block from BOM markdown. Returns `''` when there is
 * nothing to say (no rows survive the passive filter, no search dirs, or any
 * error) — the caller injects nothing rather than an empty heading.
 */
export async function bomSymbolDossier(
  bomMd: string,
  dirs: string[],
  opts: DossierOptions = {},
): Promise<string> {
  const searchCap = opts.searchCap ?? 3;
  const maxChars = opts.maxChars ?? 24_000;
  try {
    if (!dirs.length) return '';
    // No readable library at all must yield no dossier, not a page of
    // NO-INSTALLED-SYMBOL lines: a false absence claim in a machine-verified
    // block is the exact failure mode this file exists to prevent (I15).
    if (!(await listInstalledLibraries(dirs)).size) return '';
    // Group refdes by primary query so a part used five times renders once.
    // The MPN is the stronger name when present; the stage-3 scaffold's
    // UNVERIFIED flag word is not part of it. The Value is kept as a fallback
    // query, searched only when the MPN finds nothing — a bogus MPN over a
    // resolvable Value must not read as NO INSTALLED SYMBOL.
    const byQuery = new Map<string, { refs: string[]; fallback?: string }>();
    for (const row of parseBomTable(bomMd)) {
      if (PASSIVE_REFDES.test(row.refdes)) continue;
      const mpn = (row.mpn ?? '').replace(/^UNVERIFIED[:\s]*/i, '').trim();
      const value = (row.value ?? '').trim();
      const query = mpn || value;
      if (query.length < 3) continue;
      const entry = byQuery.get(query) ?? { refs: [] };
      entry.refs.push(row.refdes);
      if (mpn && value.length >= 3 && value !== mpn) entry.fallback = value;
      byQuery.set(query, entry);
    }
    if (!byQuery.size) return '';

    const lines: string[] = [];
    const overflow: string[] = [];
    const errored: string[] = [];
    // Reserve room for the two disclosure trailers up front, so the complete
    // rendered block — disclosures included — stays within maxChars.
    const TRAILER_BUDGET = Math.min(1200, Math.floor(maxChars / 4));
    const bodyBudget = maxChars - TRAILER_BUDGET;
    let spent = 0;
    for (const [query, { refs, fallback }] of byQuery) {
      const who = `${refs.join(', ')} (${query})`;
      if (spent >= bodyBudget) {
        overflow.push(who);
        continue;
      }
      let line: string;
      try {
        let hits = await searchInstalledSymbols(query, dirs, searchCap);
        let matchedBy = '';
        if (!hits.length && fallback) {
          hits = await searchInstalledSymbols(fallback, dirs, searchCap);
          if (hits.length) matchedBy = ` (matched by Value "${fallback}")`;
        }
        const top = hits[0];
        if (!top) {
          line = `- ${who}: NO INSTALLED SYMBOL matches — not capturable as named; substitute a part whose symbol exists (search_symbols to find one)`;
        } else {
          const r = await resolveLibrarySymbol(top, dirs);
          if (r.status !== 'ok') {
            // A hit that fails to re-resolve is a library race or parse quirk;
            // report the candidates without claiming pins we could not read.
            line = `- ${who}: candidates ${hits.join(', ')} — pins unreadable here; confirm with symbol_pins`;
          } else {
            const multi = r.units >= 2 ? ` — MULTI-UNIT (${r.units} units): the drafting engine refuses this symbol; choose a single-unit variant` : '';
            const also = hits.length > 1 ? `\n  also installed: ${hits.slice(1).join(', ')}` : '';
            line = `- ${who}: ${top}${matchedBy} — ${r.pins.length} pin(s): ${pinTable(r.pins)}${multi}${also}`;
          }
        }
      } catch {
        errored.push(who); // one failed probe must not sink the block
        continue;
      }
      if (spent + line.length > bodyBudget) {
        overflow.push(who);
        continue;
      }
      spent += line.length;
      lines.push(line);
    }
    if (!lines.length && !overflow.length && !errored.length) return '';
    // Two distinct disclosures: a probe error is not a size decision, and
    // labeling it "size cap" would misreport why coverage is missing.
    if (errored.length) {
      lines.push(
        boundedList(
          '- UNRESOLVED (probe error): ',
          errored,
          ' — the probe failed for these; an error says nothing about availability, call symbol_pins for each.',
          Math.floor(TRAILER_BUDGET / (overflow.length ? 2 : 1)),
        ),
      );
    }
    if (overflow.length) {
      lines.push(
        boundedList(
          `- NOT INCLUDED (size cap ${maxChars} chars): `,
          overflow,
          ' — call symbol_pins for each; nothing above says whether these resolve.',
          Math.floor(TRAILER_BUDGET / (errored.length ? 2 : 1)),
        ),
      );
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}
