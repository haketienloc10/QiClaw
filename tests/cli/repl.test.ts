import { describe, expect, it } from 'vitest';

import { buildCli } from '../../src/cli/main.js';

describe('buildCli', () => {
  it('returns an object with a run method', () => {
    const cli = buildCli();

    expect(cli).toBeTypeOf('object');
    expect(cli.run).toBeTypeOf('function');
  });

  it('returns exit code 0 when run is called', async () => {
    const cli = buildCli();

    await expect(cli.run()).resolves.toBe(0);
  });
});
