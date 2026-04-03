import { describe, expect, it, vi } from 'vitest';

import { defaultAgentSpec } from '../../src/agent/defaultAgentSpec.js';
import { buildCli } from '../../src/cli/main.js';

describe('CLI TUI mode', () => {
  it('starts the Ink app by default when --prompt is not provided', async () => {
    const runInteractiveApp = vi.fn(async () => 0);

    const cli = buildCli({
      argv: [],
      cwd: '/tmp/qiclaw-tui',
      runInteractiveApp,
      createRuntime: (runtimeOptions) => ({
        provider: { name: 'test-provider', model: 'test-model', async generate() { throw new Error('not used'); } },
        availableTools: [],
        cwd: runtimeOptions.cwd,
        observer: runtimeOptions.observer ?? { record() {} },
        agentSpec: defaultAgentSpec,
        systemPrompt: 'Test prompt',
        maxToolRounds: 3
      })
    });

    await expect(cli.run()).resolves.toBe(0);
    expect(runInteractiveApp).toHaveBeenCalledOnce();
  });
});
