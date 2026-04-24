import { describe, expect, it } from 'vitest';

import { filterToolsByPolicy } from '../../src/agent/runtime.js';
import { getBuiltinTools } from '../../src/tools/registry.js';

describe('filterToolsByPolicy', () => {
  it('keeps read-only specialist tools within the allowed capability class', () => {
    const tools = filterToolsByPolicy(getBuiltinTools(), {
      allowedCapabilityClasses: ['read']
    });

    expect(tools.map((tool) => tool.name)).toEqual(['file', 'shell', 'git', 'web_fetch']);
  });

  it('allows explicit tool names to extend the policy', () => {
    const tools = filterToolsByPolicy(getBuiltinTools(), {
      allowedCapabilityClasses: ['read'],
      allowedToolNames: ['summary_tool']
    });

    expect(tools.map((tool) => tool.name)).toEqual(['file', 'shell', 'git', 'web_fetch', 'summary_tool']);
  });
});
