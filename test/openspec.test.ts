import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({
    stdout: '',
    stderr: '',
  }),
}));

import { execa } from 'execa';
import { openspecValidate } from '../src/openspec/cli.js';

const mockedExeca = vi.mocked(execa);

describe('openspecValidate', () => {
  beforeEach(() => {
    mockedExeca.mockClear();
  });

  it('assembles validate arguments correctly', async () => {
    await openspecValidate('/repo');
    expect(mockedExeca).toHaveBeenNthCalledWith(
      1,
      'openspec',
      ['validate'],
      { cwd: '/repo' },
    );

    await openspecValidate('/repo', 'change-1');
    expect(mockedExeca).toHaveBeenNthCalledWith(
      2,
      'openspec',
      ['validate', 'change-1'],
      { cwd: '/repo' },
    );

    await openspecValidate('/repo', undefined, ['--all']);
    expect(mockedExeca).toHaveBeenNthCalledWith(
      3,
      'openspec',
      ['validate', '--all'],
      { cwd: '/repo' },
    );

    await openspecValidate('/repo', 'change-1', ['--strict']);
    expect(mockedExeca).toHaveBeenNthCalledWith(
      4,
      'openspec',
      ['validate', 'change-1', '--strict'],
      { cwd: '/repo' },
    );
  });
});