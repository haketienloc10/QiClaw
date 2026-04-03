import React from 'react';
import { describe, expect, it } from 'vitest';
import TestRenderer from 'react-test-renderer';

import { StatusBar } from '../../src/ui/components/StatusBar.js';

describe('StatusBar', () => {
  it('renders detailed provider usage and tool count', () => {
    const tree = TestRenderer.create(
      <StatusBar
        model="claude-opus-4-6"
        usage={{ inputTokens: 10, outputTokens: 32, totalTokens: 42 }}
        statusText="Completed"
        toolCount={2}
      />
    ).toJSON();

    expect(JSON.stringify(tree)).toContain('Model: claude-opus-4-6');
    expect(JSON.stringify(tree)).toContain('In 10');
    expect(JSON.stringify(tree)).toContain('Out 32');
    expect(JSON.stringify(tree)).toContain('Total 42');
    expect(JSON.stringify(tree)).toContain('Completed');
    expect(JSON.stringify(tree)).toContain('Tools 2');
  });
});
