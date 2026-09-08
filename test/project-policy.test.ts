import { describe, expect, it } from 'vitest';
import { validateKicadProjectPolicy } from '../src/kicad/project-policy.js';

function project(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    board: { design_settings: { defaults: {}, rules: {} } },
    erc: {
      erc_exclusions: [],
      rule_severities: { footprint_link_issues: 'ignore', lib_symbol_issues: 'ignore' },
    },
    net_settings: { classes: [{ name: 'Default', clearance: 0.2 }] },
    meta: { version: 1 },
    ...overrides,
  });
}

describe('KiCad project verification policy', () => {
  it('allows unrelated edits and preserves existing bootstrap ignores', () => {
    expect(validateKicadProjectPolicy(project(), project({ meta: { version: 2 } }))).toBeNull();
  });

  it('refuses newly ignored rules and severity reductions', () => {
    const withIgnoredDrc = project({
      board: {
        design_settings: {
          defaults: {},
          rule_severities: { hole_clearance: 'ignore', unconnected_items: 'ignore' },
          rules: {},
        },
      },
    });
    expect(validateKicadProjectPolicy(project(), withIgnoredDrc)).toMatch(/hole_clearance.*must be error/);

    const before = project({ board: { design_settings: { rule_severities: { hole_clearance: 'error' } } } });
    const after = project({ board: { design_settings: { rule_severities: { hole_clearance: 'warning' } } } });
    expect(validateKicadProjectPolicy(before, after)).toMatch(/lowers severity from error to warning/);
  });

  it('allows tightening an existing ignore and removing an ignore', () => {
    const tightened = JSON.parse(project()) as Record<string, unknown>;
    (tightened.erc as Record<string, unknown>).rule_severities = { footprint_link_issues: 'warning' };
    expect(validateKicadProjectPolicy(project(), JSON.stringify(tightened))).toBeNull();
  });

  it('refuses clearance reductions and removals but allows increases', () => {
    const withClearance = (clearance?: number): string =>
      project({ net_settings: { classes: [{ name: 'Default', ...(clearance === undefined ? {} : { clearance }) }] } });
    expect(validateKicadProjectPolicy(withClearance(0.2), withClearance(0.1))).toMatch(
      /lowers clearance from 0.2 to 0.1/,
    );
    expect(validateKicadProjectPolicy(withClearance(0.2), withClearance())).toMatch(/removes clearance 0.2/);
    expect(validateKicadProjectPolicy(withClearance(0.2), withClearance(0.25))).toBeNull();
  });

  it('refuses added exclusions and allows exclusions to be removed', () => {
    const exclusions = (items: string[]): string =>
      project({ erc: { erc_exclusions: items, rule_severities: {} } });
    expect(validateKicadProjectPolicy(exclusions([]), exclusions(['uuid:pin']))).toMatch(
      /erc_exclusions adds a verification exclusion/,
    );
    expect(validateKicadProjectPolicy(exclusions(['uuid:pin']), exclusions([]))).toBeNull();
  });

  it('refuses invalid output but permits repair of pre-existing invalid JSON', () => {
    expect(validateKicadProjectPolicy(project(), '{')).toMatch(/project JSON would be invalid/);
    expect(validateKicadProjectPolicy('{', project())).toBeNull();
  });
});
