import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const testDirectoryPath = dirname(fileURLToPath(import.meta.url));
const projectRootPath = resolve(testDirectoryPath, '..', '..');

function readProjectFile(relativePath: string) {
  return readFileSync(resolve(projectRootPath, relativePath), 'utf8');
}

describe('summary tool asset and documentation wiring', () => {
  it('includes the Python worker source file', () => {
    expect(existsSync(resolve(projectRootPath, 'src/tools/python/summary_worker.py'))).toBe(true);
  });

  it('copies Python tool assets into dist during build', () => {
    const copyScript = readProjectFile('scripts/copy-agent-assets.mjs');

    expect(copyScript).toContain('src/tools/python');
    expect(copyScript).toContain('dist/tools/python');
  });

  it('declares dedicated scripts for summary worker smoke and integration checks', () => {
    const packageJson = JSON.parse(readProjectFile('package.json')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts).toMatchObject({
      'summary:smoke': expect.any(String),
      'summary:integration': expect.any(String)
    });
  });

  it('lists required Python dependencies for the summary tool worker', () => {
    const requirementsPath = resolve(projectRootPath, 'requirements-summary-tool.txt');

    expect(existsSync(requirementsPath)).toBe(true);

    const requirements = readFileSync(requirementsPath, 'utf8');

    expect(requirements).toContain('underthesea');
    expect(requirements).toContain('rapidfuzz');
    expect(requirements).toContain('scikit-learn');
    expect(requirements).toContain('networkx');
  });

  it('mentions summary_tool in readonly tools documentation', () => {
    const toolsDoc = readProjectFile('src/agent/builtin-packages/readonly/TOOLS.md');

    expect(toolsDoc).toContain('summary_tool');
  });
});
