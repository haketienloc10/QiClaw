import { describe, expect, it } from 'vitest';

import type { Tool } from '../../src/tools/tool.js';
import { validateToolInput } from '../../src/tools/validation.js';

const demoTool: Tool = {
  name: 'demo_tool',
  description: 'Demo tool for validation tests',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      args: {
        type: 'array',
        items: { type: 'string' }
      }
    },
    required: ['path'],
    additionalProperties: false
  },
  async execute() {
    return { content: 'ok' };
  }
};

describe('validateToolInput', () => {
  it('accepts valid object input', () => {
    expect(() => validateToolInput(demoTool, { path: 'note.txt', args: ['a', 'b'] })).not.toThrow();
  });

  it('rejects non-object input', () => {
    expect(() => validateToolInput(demoTool, 'note.txt')).toThrow(/expected an object/i);
  });

  it('rejects missing required properties', () => {
    expect(() => validateToolInput(demoTool, { args: ['a'] })).toThrow(/missing required property "path"/i);
  });

  it('rejects unexpected properties when additionalProperties is false', () => {
    expect(() => validateToolInput(demoTool, { path: 'note.txt', extra: true })).toThrow(/unexpected property "extra"/i);
  });

  it('rejects non-string values for string properties', () => {
    expect(() => validateToolInput(demoTool, { path: 123 })).toThrow(/path: expected a string/i);
  });

  it('rejects non-array values for array properties', () => {
    expect(() => validateToolInput(demoTool, { path: 'note.txt', args: 'oops' })).toThrow(/args: expected an array/i);
  });

  it('rejects non-string array items', () => {
    expect(() => validateToolInput(demoTool, { path: 'note.txt', args: ['ok', 2] })).toThrow(/args\[\]: expected a string/i);
  });
});
