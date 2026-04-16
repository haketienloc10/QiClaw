import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('package scripts', () => {
  it('rebuilds the Rust TUI before npm run dev launches the CLI', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    ) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.dev).toContain('build:tui');
    expect(packageJson.scripts?.dev).toContain('tsx src/cli/main.ts');
  });
});
