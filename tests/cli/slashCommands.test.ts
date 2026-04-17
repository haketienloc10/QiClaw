import { describe, expect, it } from 'vitest';

import {
  buildSlashCommandCatalog,
  normalizeSlashCommandInput,
  resolveSlashCommand
} from '../../src/cli/slashCommands.js';

describe('slashCommands', () => {
  it('builds a practical catalog including direct and prompt-backed commands', () => {
    const catalog = buildSlashCommandCatalog();
    const names = catalog.map((entry) => entry.name);

    expect(names).toEqual([
      '/help',
      '/clear',
      '/compact',
      '/status',
      '/tools',
      '/memory',
      '/recal',
      '/doctor',
      '/diff',
      '/review',
      '/model'
    ]);

    expect(resolveSlashCommand('/diff')?.kind).toBe('direct');
    expect(resolveSlashCommand('/recal')?.kind).toBe('direct');
    expect(resolveSlashCommand('/review')?.kind).toBe('prompt');
  });

  it('normalizes slash input into command name and argument text', () => {
    expect(normalizeSlashCommandInput('/model openai:gpt-5')).toEqual({
      name: '/model',
      argsText: 'openai:gpt-5'
    });
  });

  it('returns undefined for unknown slash commands', () => {
    expect(resolveSlashCommand('/unknown')).toBeUndefined();
    expect(normalizeSlashCommandInput('hello')).toBeUndefined();
  });
});
