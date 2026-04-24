import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('package scripts', () => {
  it('keeps npm run dev focused on the CLI entrypoint while dev:tui rebuilds the Rust TUI first', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    ) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.dev).toBe('tsx src/cli/main.ts');
    expect(packageJson.scripts?.dev).not.toContain('build:tui');
    expect(packageJson.scripts?.['dev:tui']).toBe('npm run build:tui && tsx src/cli/main.ts');
  });

  it('adds a fixed npm script for importing blueprint JSON files', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    ) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['blueprint:import']).toBe('tsx src/cli/main.ts --blueprint-import blueprints');
  });
});
