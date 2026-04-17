import type { SlashCatalogEntry } from './tuiProtocol.js';

export interface SlashCommandDefinition extends SlashCatalogEntry {
  promptTemplate?: (argsText: string) => string;
}

const slashCommands: SlashCommandDefinition[] = [
  { name: '/help', description: 'Show available commands', usage: '/help', kind: 'direct' },
  { name: '/clear', description: 'Clear the current session transcript', usage: '/clear', kind: 'state' },
  { name: '/compact', description: 'Show a compact session summary', usage: '/compact', kind: 'direct' },
  { name: '/status', description: 'Show current session status', usage: '/status', kind: 'direct' },
  { name: '/tools', description: 'List available tools', usage: '/tools', kind: 'direct' },
  { name: '/memory', description: 'Show session memory status', usage: '/memory', kind: 'direct' },
  { name: '/recal', description: 'Inspect recalled memories for an input', usage: '/recal <input>', kind: 'direct' },
  { name: '/doctor', description: 'Show environment diagnostics', usage: '/doctor', kind: 'direct' },
  { name: '/diff', description: 'Show safe working tree diff summary', usage: '/diff', kind: 'direct' },
  {
    name: '/review',
    description: 'Ask the agent runtime to review current work',
    usage: '/review [focus]',
    kind: 'prompt',
    promptTemplate: (argsText) => argsText.length > 0
      ? `Please review the current work in this repository. Focus especially on: ${argsText}`
      : 'Please review the current work in this repository. Summarize notable issues, strengths, and next steps.'
  },
  { name: '/model', description: 'Show current model or set an explicit clean-session model', usage: '/model [provider:model]', kind: 'direct' }
];

const slashCommandsByName = new Map(slashCommands.map((command) => [command.name, command]));

export function buildSlashCommandCatalog(): SlashCatalogEntry[] {
  return slashCommands.map(({ promptTemplate: _promptTemplate, ...command }) => command);
}

export function resolveSlashCommand(name: string): SlashCommandDefinition | undefined {
  return slashCommandsByName.get(name.trim());
}

export function normalizeSlashCommandInput(input: string): { name: string; argsText: string } | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return undefined;
  }

  const [name, ...rest] = trimmed.split(/\s+/u);
  if (!name) {
    return undefined;
  }

  return {
    name,
    argsText: rest.join(' ').trim()
  };
}
