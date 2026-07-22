import { describe, expect, it } from 'vitest';
import { program } from '../src/cli.js';

describe('CLI help', () => {
  it('exposes --keep-on-fail on both do and create', async () => {
    for (const name of ['do', 'create']) {
      const command = program.commands.find((candidate) => candidate.name() === name);
      expect(command, `${name} command exists`).toBeDefined();
      expect(command!.options.map((option) => option.long)).toContain('--keep-on-fail');
      expect(command!.helpInformation()).toContain('--keep-on-fail');
    }
  });
});
