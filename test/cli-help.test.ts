import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);

describe('CLI help', () => {
  it('exposes --keep-on-fail on both do and create', async () => {
    // Commander command actions call process.exit, so assert the declarative
    // CLI surface directly; build verification separately executes the CLI.
    const source = await readFile(path.join(root, 'src', 'cli.ts'), 'utf8');
    expect(source.match(/\.option\('--keep-on-fail'/g)).toHaveLength(2);
    expect(source.match(/keepOnFail: opts\.keepOnFail \?\? false/g)).toHaveLength(2);
  });
});
