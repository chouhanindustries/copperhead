import { describe, it, expect } from 'vitest';
import { corruptionError } from '../src/agent/tools.js';

// I2: a UTF-8 multibyte glyph split across a streaming chunk boundary arrives as
// U+FFFD (the replacement char). The content-bearing tools reject such args so
// the model re-emits instead of writing a mangled value (e.g. "5.1kΩ" → "5.1k�")
// to disk.
describe('corruptionError (I2: reject U+FFFD in tool args)', () => {
  it('flags a field containing the replacement character', () => {
    const err = corruptionError({ content: 'Rd = 5.1k� to GND' });
    expect(err).toBeTruthy();
    expect(err).toContain('U+FFFD');
    expect(err).toContain('content');
  });

  it('passes clean text through (null = no problem)', () => {
    expect(corruptionError({ content: 'Rd = 5.1kΩ to GND' })).toBeNull();
    expect(corruptionError({ decision: 'use 5.1 kohm', rationale: 'CC pull-down' })).toBeNull();
  });

  it('names every corrupted field, ignores non-string args', () => {
    const err = corruptionError({
      decision: 'ok',
      rationale: 'µ�F cap',
      affects: 'C1�',
      count: 3,
    });
    expect(err).toContain('rationale');
    expect(err).toContain('affects');
    expect(err).not.toContain('decision');
  });

  it('returns null for an empty / all-clean field set', () => {
    expect(corruptionError({})).toBeNull();
    expect(corruptionError({ x: undefined, y: 42 })).toBeNull();
  });
});
