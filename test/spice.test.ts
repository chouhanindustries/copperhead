import { describe, expect, it } from 'vitest';
import {
  SimulationParseError,
  compileSpiceAssertion,
  parseSimulationBlocks,
  parseSpiceAssertion,
  parseSpiceNumber,
  type SpiceMeasurable,
} from '../src/kicad/spice.js';

describe('parseSimulationBlocks', () => {
  it('parses sheet scope, analysis, sources, and assertions with source lines', () => {
    const markdown = `# Power subsystem

## Simulation
scope: sheet /Power/Reference
analysis: op
source: VIN=3.3V
sources: ENABLE=1
assert: V(VREF) between 3.25 and 3.35
assert: I(R5) < 25uA

## Notes
Keep the reference close to the ADC.
`;

    expect(parseSimulationBlocks(markdown)).toEqual([
      {
        line: 3,
        scope: { kind: 'sheet', sheet: '/Power/Reference' },
        analysis: 'op',
        sources: [
          {
            port: 'VIN',
            value: { raw: '3.3V', value: 3.3, unit: 'V' },
            line: 6,
          },
          {
            port: 'ENABLE',
            value: { raw: '1', value: 1, unit: '' },
            line: 7,
          },
        ],
        assertions: [
          {
            raw: 'V(VREF) between 3.25 and 3.35',
            line: 8,
            measurable: { kind: 'voltage', target: 'VREF' },
            comparator: {
              kind: 'between',
              lower: { raw: '3.25', value: 3.25, unit: '' },
              upper: { raw: '3.35', value: 3.35, unit: '' },
            },
          },
          {
            raw: 'I(R5) < 25uA',
            line: 9,
            measurable: { kind: 'current', target: 'R5' },
            comparator: {
              kind: 'less-than',
              bound: { raw: '25uA', value: 25 * 1e-6, unit: 'A' },
            },
          },
        ],
      },
    ]);
  });

  it('parses explicit net scopes and removes duplicate nets', () => {
    const markdown = `## Simulation
scope: nets [VIN, VOUT, GND, VOUT]
analysis: tran
assert: V(VOUT) > 1.2V
`;

    expect(parseSimulationBlocks(markdown)[0]).toMatchObject({
      scope: { kind: 'nets', nets: ['VIN', 'VOUT', 'GND'] },
      analysis: 'tran',
    });
  });

  it('returns an empty list when the document has no Simulation block', () => {
    expect(parseSimulationBlocks('# Subsystems\n\nNo simulations configured.\n')).toEqual([]);
  });

  it('rejects raw ngspice control statements and names the source line', () => {
    const markdown = `# Power

## Simulation
scope: sheet /Power
analysis: op
.control
assert: V(VREF) > 3V
`;

    expect(() => parseSimulationBlocks(markdown)).toThrowError(
      new SimulationParseError(6, 'raw ngspice statement ".control" is not allowed'),
    );
  });

  it('reports the heading line when a required field is missing', () => {
    const markdown = `# Power

## Simulation
scope: nets VIN, GND
analysis: dc
`;

    expect(() => parseSimulationBlocks(markdown)).toThrowError(
      new SimulationParseError(3, 'Simulation block needs at least one assertion'),
    );
  });
});

describe('parseSpiceNumber', () => {
  it.each([
    ['3.3', 3.3, ''],
    ['25uA', 25e-6, 'A'],
    ['10k', 10_000, ''],
    ['2MEGOhm', 2e6, 'Ohm'],
    ['-4.7mV', -4.7e-3, 'V'],
    ['1e-9A', 1e-9, 'A'],
  ])('parses %s with its SI multiplier', (raw, value, unit) => {
    const parsed = parseSpiceNumber(raw);
    expect(parsed).toMatchObject({ raw, unit });
    expect(parsed.value).toBeCloseTo(value, 12);
  });

  it('rejects unsupported numeric syntax', () => {
    expect(() => parseSpiceNumber('NaN', 14)).toThrowError(
      new SimulationParseError(14, 'invalid SPICE number "NaN"'),
    );
  });
});

describe('parseSpiceAssertion', () => {
  it('rejects arbitrary expressions outside the closed grammar', () => {
    expect(() => parseSpiceAssertion('max(V(OUT)) < 5', 22)).toThrowError(
      new SimulationParseError(22, 'invalid SPICE assertion "max(V(OUT)) < 5"'),
    );
  });

  it('rejects reversed between bounds', () => {
    expect(() => parseSpiceAssertion('V(OUT) between 5 and 3', 9)).toThrowError(
      new SimulationParseError(9, 'between lower bound must be less than upper bound'),
    );
  });
});

describe('compileSpiceAssertion', () => {
  it('compiles a V(VREF) between assertion with both bounds evaluated', () => {
    const assertion = parseSpiceAssertion('V(VREF) between 3.25 and 3.35', 12);

    expect(compileSpiceAssertion(assertion, 'op', 'vref')).toEqual({
      valueName: 'vref_value',
      checks: [
        { name: 'vref_lower_margin', pass: 'nonnegative' },
        { name: 'vref_upper_margin', pass: 'nonnegative' },
      ],
      lines: [
        '.meas op vref_value FIND v(VREF)',
        ".meas op vref_lower_margin PARAM='vref_value - 3.25'",
        ".meas op vref_upper_margin PARAM='3.35 - vref_value'",
      ],
      deck: `.meas op vref_value FIND v(VREF)
.meas op vref_lower_margin PARAM='vref_value - 3.25'
.meas op vref_upper_margin PARAM='3.35 - vref_value'`,
    });
  });

  const measurables: Array<[string, SpiceMeasurable, string]> = [
    ['V(net)', { kind: 'voltage', target: 'OUT' }, 'v(OUT)'],
    ['I(refdes)', { kind: 'current', target: 'R5' }, 'i(R5)'],
    ['corner(net)', { kind: 'corner', target: 'OUT' }, 'vdb(OUT)'],
  ];
  const comparators = [
    'between 1kHz and 2kHz',
    '< 2kHz',
    '> 1kHz',
  ] as const;

  it.each(
    measurables.flatMap(([measurableLabel, measurable, expression]) =>
      comparators.map(
        (comparator) =>
          [`${measurableLabel} ${comparator}`, measurable, expression, comparator] as const,
      ),
    ),
  )('compiles %s', (_label, measurable, expression, comparator) => {
    const measurableText =
      measurable.kind === 'voltage'
        ? 'V(OUT)'
        : measurable.kind === 'current'
          ? 'I(R5)'
          : 'corner(OUT)';
    const assertion = parseSpiceAssertion(`${measurableText} ${comparator}`);
    const result = compileSpiceAssertion(assertion, 'ac', 'check');

    expect(result.lines[0]).toContain(expression);
    expect(result.lines).toHaveLength(comparator.startsWith('between') ? 3 : 2);
    expect(result.lines.slice(1).every((line) => line.includes("PARAM='"))).toBe(true);
    const expectedPass = comparator.startsWith('between') ? 'nonnegative' : 'positive';
    expect(result.checks.every((check) => check.pass === expectedPass)).toBe(true);
  });

  it('only permits corner measurements in an AC analysis', () => {
    const assertion = parseSpiceAssertion('corner(OUT) < 10k');
    expect(() => compileSpiceAssertion(assertion, 'tran')).toThrowError(
      new SimulationParseError(1, 'corner() requires an ac analysis'),
    );
  });
});
