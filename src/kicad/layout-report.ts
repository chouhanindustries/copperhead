import type { HardRow, LayoutMetrics, SoftMetrics } from './layout-metrics.js';

/**
 * Rendering for layout metrics (design D11). The `## Draft quality` section of
 * `docs/LAYOUT.md` is generated from the scorecard and only annotated by the
 * model: "unlabeled non-optimal is not acceptable" stops being an honour-system
 * instruction once the labels are computed.
 *
 * The section is regenerated in place. Everything the model wrote below the
 * marker line survives, so the computed part stays current and the judgement
 * part is never overwritten.
 */

export const DRAFT_QUALITY_TITLE = 'Draft quality';

export const DRAFT_QUALITY_MARKER =
  '<!-- copperhead:notes, everything below this line is preserved when the block above is regenerated -->';

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

function scoreTable(m: LayoutMetrics): string[] {
  return [
    '| Term | Points | Detail |',
    '| --- | ---: | --- |',
    ...m.terms.map((t) => `| ${t.name} | ${t.points} / ${t.max} | ${t.detail} |`),
  ];
}

function hardTable(rows: HardRow[]): string[] {
  if (!rows.length) {
    return [
      'No key in `.copperhead/constraints.json` matches a measurable layout constraint, so this board has no hard table. Record the relevant constraints (trace width, board outline, keepouts, mounting-hole clearance, decoupling distance, copper area) and the rows appear here.',
    ];
  }
  return [
    '| Constraint key | Check | Expected | Measured | Status |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| \`${r.key}\` | ${r.metric}${r.note ? ` (${r.note})` : ''} | ${r.expected} | ${r.actual} | ${r.status} |`,
    ),
  ];
}

function softTable(s: SoftMetrics): string[] {
  const unrouted = s.unroutedNetNames.length ? s.unroutedNetNames.map((n) => `\`${n}\``).join(', ') : 'none';
  return [
    '| Metric | Value |',
    '| --- | --- |',
    `| Footprints | ${s.footprints} |`,
    `| Routed nets | ${s.routedNets} of ${s.routableNets} (${pct(s.routedNetFraction)}) |`,
    `| Unrouted nets | ${unrouted} |`,
    `| Total track length | ${s.trackLengthMm} mm |`,
    `| Track segments | ${s.segments} |`,
    `| Vias | ${s.vias} |`,
    `| Copper zones | ${s.zones} |`,
    `| Courtyard overlaps | ${s.courtyardOverlaps} |`,
    `| Off-board footprints | ${s.offBoardFootprints} |`,
    `| Board area | ${s.boardAreaMm2} mm2 |`,
    `| Placement density | ${pct(s.placementDensity)} |`,
    `| Copper area | ${s.copperAreaMm2} mm2 |`,
  ];
}

/** The generated body of the `## Draft quality` section, without its heading. */
export function renderDraftQuality(m: LayoutMetrics): string {
  const source = m.board ? `\`${m.board}\`` : 'the configured board';
  return [
    `Computed by \`layout_metrics\` from ${source}. This block is regenerated after every layout stage: edit the notes below the marker instead.`,
    '',
    `**Layout score: ${m.score} / 100**`,
    '',
    ...scoreTable(m),
    '',
    '### Hard constraints',
    '',
    ...hardTable(m.hard),
    '',
    '### Soft scorecard',
    '',
    ...softTable(m.soft),
  ].join('\n');
}

const HEADING_RE = /^(#{1,6})\s+.*\bdraft quality\b/i;

const trimBlank = (lines: string[]): string[] => {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === '') start++;
  while (end > start && lines[end - 1]!.trim() === '') end--;
  return lines.slice(start, end);
};

const DEFAULT_NOTES =
  'Notes: state exactly what is fine and what a human or a specialist tool should redo. Non-optimal is acceptable; unlabeled non-optimal is not.';

/**
 * Replace the generated part of the `## Draft quality` section in place, keeping
 * whatever sits below the marker. A section that predates the marker (the model
 * wrote it by hand) has its whole body treated as notes, so the first
 * regeneration preserves rather than destroys the model's judgement.
 */
export function upsertDraftQuality(doc: string, generated: string): string {
  const lines = doc.split('\n');
  const headingIdx = lines.findIndex((l) => HEADING_RE.test(l));

  let level = 2;
  let notes: string[] = [];
  let before: string[];
  let after: string[];

  if (headingIdx === -1) {
    before = trimBlank(lines);
    after = [];
  } else {
    level = (HEADING_RE.exec(lines[headingIdx]!)?.[1] ?? '##').length;
    let end = lines.length;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      const m = /^(#{1,6})\s/.exec(lines[i]!);
      if (m && m[1]!.length <= level) {
        end = i;
        break;
      }
    }
    const body = lines.slice(headingIdx + 1, end);
    const markerIdx = body.findIndex((l) => l.trim().startsWith('<!-- copperhead:notes'));
    notes = trimBlank(markerIdx === -1 ? body : body.slice(markerIdx + 1));
    before = lines.slice(0, headingIdx);
    after = lines.slice(end);
  }

  // Blank-line normalization applies to the generated block only. The seams
  // are single blank lines by construction (`before`, `notes` and `after` are
  // edge-trimmed), and everything the user or the model wrote, including blank
  // runs inside fenced code blocks either side of the section, is preserved
  // byte for byte.
  const section = [
    `${'#'.repeat(level)} ${DRAFT_QUALITY_TITLE}`,
    '',
    generated.replace(/\n{3,}/g, '\n\n'),
    '',
    DRAFT_QUALITY_MARKER,
    '',
    ...(notes.length ? notes : [DEFAULT_NOTES]),
  ];
  const out = [...(before.length ? [...trimBlank(before), ''] : []), ...section];
  const tail = trimBlank(after);
  if (tail.length) out.push('', ...tail);
  return out.join('\n') + '\n';
}

/** Plain-text scorecard for the agent, in the voice of the ERC/DRC reports. */
export function formatLayoutMetrics(m: LayoutMetrics): string {
  const lines = [`layout score: ${m.score}/100 for ${m.board || 'the configured board'}`];
  for (const t of m.terms) lines.push(`  ${t.name}: ${t.points}/${t.max} (${t.detail})`);
  lines.push('hard constraints:');
  if (!m.hard.length) {
    lines.push('  (none: no key in .copperhead/constraints.json matches a measurable layout constraint)');
  } else {
    for (const r of m.hard) {
      lines.push(
        `  [${r.status}] ${r.key}, ${r.metric}: expected ${r.expected}, measured ${r.actual}${r.note ? ` (${r.note})` : ''}`,
      );
    }
  }
  const s = m.soft;
  lines.push('soft metrics:');
  lines.push(
    `  footprints=${s.footprints} routed=${s.routedNets}/${s.routableNets} track=${s.trackLengthMm}mm ` +
      `segments=${s.segments} vias=${s.vias} zones=${s.zones} courtyardOverlaps=${s.courtyardOverlaps} ` +
      `offBoard=${s.offBoardFootprints} boardArea=${s.boardAreaMm2}mm2 density=${pct(s.placementDensity)}`,
  );
  lines.push(`  unrouted nets: ${s.unroutedNetNames.length ? s.unroutedNetNames.join(', ') : 'none'}`);
  return lines.join('\n');
}
