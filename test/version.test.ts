import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('README version', () => {
  it('agrees with package.json', () => {
    const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      version: string;
    };
    const majorMinor = version.split('.').slice(0, 2).join('.');
    const readme = readFileSync(path.join(root, 'README.md'), 'utf8');

    // The README normally states no version at all (the npm badge carries it).
    // Any vX.Y[.Z] someone writes in must be the current version, either exact
    // or truncated to major.minor; a stale number here is drift.
    const mentions = [...readme.matchAll(/\bv(\d+\.\d+(?:\.\d+)?)\b/g)].map((m) => m[1]);
    for (const mention of mentions) {
      expect([version, majorMinor]).toContain(mention);
    }
  });
});
