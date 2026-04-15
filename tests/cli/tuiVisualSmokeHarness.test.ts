import { describe, expect, it } from 'vitest';

import { createDeterministicTuiSmokeHarness } from '../../src/cli/tuiVisualSmokeHarness.js';

describe('tuiVisualSmokeHarness', () => {
  it('builds a deterministic script command that captures a running tool cell and completed preview', () => {
    const harness = createDeterministicTuiSmokeHarness({
      repoRoot: '/tmp/qiclaw',
      binaryPath: '/tmp/qiclaw/tui/target/debug/qiclaw-tui',
      outputPath: '/tmp/qiclaw-smoke.txt'
    });

    expect(harness.command).toContain("script -q -c '");
    expect(harness.command).toContain('/tmp/qiclaw/tui/target/debug/qiclaw-tui');
    expect(harness.command).toContain('tool_started');
    expect(harness.command).toContain('tool_completed');
    expect(harness.command).toContain('git status');
    expect(harness.command).toContain('On branch main');
    expect(harness.command).toContain('/tmp/qiclaw-smoke.txt');
  });
});
