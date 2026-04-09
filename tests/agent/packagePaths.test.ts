import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getBuiltinAgentPackageDirectory,
  getProjectAgentPackageDirectory,
  getUserAgentPackageDirectory
} from '../../src/agent/packagePaths.js';

describe('packagePaths', () => {
  it('builds builtin, project, and user package directories deterministically', () => {
    expect(getProjectAgentPackageDirectory('/workspace/app', 'reviewer')).toBe(
      join('/workspace/app', '.qiclaw', 'agents', 'reviewer')
    );

    expect(getUserAgentPackageDirectory('reviewer')).toBe(join(homedir(), '.qiclaw', 'agents', 'reviewer'));

    expect(getBuiltinAgentPackageDirectory('readonly', '/builtin-packages')).toBe(
      join('/builtin-packages', 'readonly')
    );
  });

  it('rejects invalid preset names before building package directories', () => {
    for (const preset of ['Reviewer', '../escape', 'nested/path', 'nested\\path', 'two..dots', 'with space']) {
      expect(() => getProjectAgentPackageDirectory('/workspace/app', preset)).toThrow(
        `Invalid agent preset name: "${preset}".`
      );
      expect(() => getUserAgentPackageDirectory(preset, '/home/tester')).toThrow(
        `Invalid agent preset name: "${preset}".`
      );
      expect(() => getBuiltinAgentPackageDirectory(preset, '/builtin-packages')).toThrow(
        `Invalid agent preset name: "${preset}".`
      );
    }
  });
});
