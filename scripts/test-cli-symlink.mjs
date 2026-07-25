import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(repoRoot, 'dist', 'cli.js');
const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-bin-'));
const bin = path.join(dir, 'copperhead');

const cases = [
  { args: ['--help'], expected: ['Usage: copperhead', 'create', 'check'] },
  { args: ['do', '--help'], expected: ['--keep-on-fail'] },
  { args: ['create', '--help'], expected: ['--keep-on-fail'] },
];

try {
  await symlink(cli, bin);
  for (const { args, expected } of cases) {
    const result = spawnSync(process.execPath, [bin, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const missing = expected.filter((text) => !result.stdout.includes(text));
    if (result.status !== 0 || missing.length > 0) {
      throw new Error(
        [
          `CLI symlink smoke failed for: copperhead ${args.join(' ')}`,
          `exit: ${result.status ?? 'null'}`,
          `missing: ${missing.join(', ') || 'none'}`,
          `stdout: ${result.stdout}`,
          `stderr: ${result.stderr}`,
          result.error ? `error: ${result.error.message}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
  }
  console.log('CLI symlink smoke passed');
} finally {
  await rm(dir, { recursive: true, force: true });
}
