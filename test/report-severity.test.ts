import { describe, expect, it } from 'vitest';
import { normalizeReport } from '../src/kicad/report.js';

describe('normalizeReport severity gate', () => {
  it('warning-only reports are ok, and the warnings stay listed', () => {
    const raw = {
      sheets: [{ path: '/', violations: [
        { severity: 'warning', type: 'lib_symbol_mismatch', description: 'advisory' },
      ] }],
    };
    const rep = normalizeReport(raw, 'erc');
    expect(rep.ok).toBe(true);
    expect(rep.violations).toHaveLength(1);
    expect(rep.violations[0].severity).toBe('warning');
  });

  it('one error among warnings blocks', () => {
    const raw = {
      violations: [
        { severity: 'warning', type: 'lib_symbol_mismatch', description: 'advisory' },
        { severity: 'error', type: 'pin_not_connected', description: 'real' },
      ],
    };
    expect(normalizeReport(raw, 'drc').ok).toBe(false);
  });

  it('missing severity is treated as an error for safety', () => {
    const raw = { violations: [{ type: 'unknown_thing', description: 'no severity field' }] };
    expect(normalizeReport(raw, 'erc').ok).toBe(false);
  });

  it('an empty report is still clean', () => {
    expect(normalizeReport({}, 'erc').ok).toBe(true);
  });
});
