/**
 * A run-blocking environment failure. Distinct from a mid-run error: nothing
 * has been written yet, so the message alone is the whole user experience.
 * The formatted message carries the reason, why copperhead refuses to run,
 * and concrete remedy steps — every CLI catch path prints err.message, so
 * embedding the explanation here means no call site needs special rendering.
 */
export class PreflightError extends Error {
  constructor(
    readonly reason: string,
    readonly why: string,
    readonly remedy: string[],
  ) {
    super(formatPreflightFailure(reason, why, remedy));
    this.name = 'PreflightError';
  }
}

export function formatPreflightFailure(reason: string, why: string, remedy: string[]): string {
  const steps = remedy.map((step, i) => `  ${i + 1}. ${step}`);
  return [reason, '', `why it failed: ${why}`, 'to fix:', ...steps].join('\n');
}
