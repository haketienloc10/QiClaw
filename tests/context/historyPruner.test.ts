import { describe, expect, it } from 'vitest';

import type { Message } from '../../src/core/types.js';
import { compactHistoryMessages } from '../../src/context/compactor.js';
import { buildPromptWithContext } from '../../src/context/promptBuilder.js';
import { pruneHistoryForContext } from '../../src/context/historyPruner.js';

function message(role: Message['role'], content: string, name?: string): Message {
  return name ? { role, content, name } : { role, content };
}

describe('compactHistoryMessages', () => {
  it('creates deterministic summary lines and preserves tool evidence', () => {
    const summary = compactHistoryMessages([
      message('user', 'Need a very long explanation about the repository state and pending work items.'),
      message('assistant', 'I will inspect the repository, compare the files, and explain the likely cause.'),
      message('assistant', 'Tool call: read_file README.md'),
      message('tool', 'README.md contents: alpha beta gamma delta epsilon zeta eta theta', 'read_file')
    ], {
      maxLines: 6,
      maxChars: 220,
      snippetLength: 36
    });

    expect(summary).toBe([
      'History summary:',
      '- user: Need a very long explanation about…',
      '- assistant: I will inspect the repository, com…',
      '- assistant: Tool call: read_file README.md',
      '- tool(read_file): README.md contents: alpha beta gam…'
    ].join('\n'));
  });

  it('reserves space for tool evidence when tool history exists later in older messages', () => {
    const summary = compactHistoryMessages([
      message('user', 'First long planning note about repository architecture and migration steps.'),
      message('assistant', 'Second long planning note that fills up most of the summary budget quickly.'),
      message('assistant', 'Tool call: search src/context'),
      message('tool', 'search results found historyPruner.ts and compactor.ts entries', 'search')
    ], {
      maxLines: 4,
      maxChars: 120,
      snippetLength: 28
    });

    expect(summary).toBe([
      'History summary:',
      '- user: First long planning note a…',
      '- assistant: Second long planning note…',
      '- tool(search): search res…'
    ].join('\n'));
  });

  it('never exceeds maxChars even when the budget is smaller than the header', () => {
    expect(compactHistoryMessages([
      message('user', 'alpha beta gamma')
    ], {
      maxLines: 3,
      maxChars: 5,
      snippetLength: 10
    })).toBe('Hist…');
  });
});

describe('buildPromptWithContext', () => {
  it('does not inject a blank memory user message for empty memory text', () => {
    const result = buildPromptWithContext({
      baseSystemPrompt: 'Base system prompt',
      memoryText: '   \n\t  ',
      history: [
        message('user', 'Current question')
      ]
    });

    expect(result.messages).toEqual([
      message('system', 'Base system prompt'),
      message('user', 'Current question')
    ]);
  });

  it('keeps memory text out of the system prompt and inserts it before conversation history', () => {
    const result = buildPromptWithContext({
      baseSystemPrompt: 'Base system prompt',
      memoryText: 'Mem:\n- stable recalled fact',
      skillsText: 'Loaded skills',
      historySummary: 'History summary: previous turns',
      history: [
        message('user', 'Current question'),
        message('assistant', 'Current answer')
      ]
    });

    expect(result.systemPrompt).toBe([
      'Base system prompt',
      'Loaded skills',
      'History summary: previous turns'
    ].join('\n\n'));
    expect(result.messages).toEqual([
      {
        role: 'system',
        content: ['Base system prompt', 'Loaded skills', 'History summary: previous turns'].join('\n\n')
      },
      {
        role: 'user',
        content: 'Mem:\n- stable recalled fact'
      },
      message('user', 'Current question'),
      message('assistant', 'Current answer')
    ]);
  });
});

describe('pruneHistoryForContext', () => {
  it('keeps recent messages and returns a summary separately when older history exceeds the threshold', () => {
    const history = [
      message('user', 'User opening request with a lot of context about the project and goals.'),
      message('assistant', 'Assistant acknowledges and plans the next inspection steps carefully.'),
      message('assistant', 'Tool call: search README'),
      message('tool', 'search hit README.md:42', 'search'),
      message('user', 'Recent follow-up asking for concrete implementation details.'),
      message('assistant', 'Recent answer confirming the next coding step.')
    ];

    const result = pruneHistoryForContext(history, {
      recentMessageCount: 2,
      oldHistoryBudgetChars: 160,
      summaryMaxLines: 5,
      summaryMaxChars: 160,
      summarySnippetLength: 30
    });

    expect(result.didCompact).toBe(true);
    expect(result.summary).toBe([
      'History summary:',
      '- user: User opening request with a…',
      '- assistant: Assistant acknowledges and p…',
      '- assistant: Tool call: search README',
      '- tool(search): search h…'
    ].join('\n'));
    expect(result.messages).toEqual([
      message('user', 'Recent follow-up asking for concrete implementation details.'),
      message('assistant', 'Recent answer confirming the next coding step.')
    ]);
  });

  it('keeps older messages as-is when they fit inside the old-history budget', () => {
    const history = [
      message('user', 'alpha'),
      message('assistant', 'beta'),
      message('user', 'gamma'),
      message('assistant', 'delta')
    ];

    const result = pruneHistoryForContext(history, {
      recentMessageCount: 2,
      oldHistoryBudgetChars: 32,
      summaryMaxLines: 4,
      summaryMaxChars: 80,
      summarySnippetLength: 20
    });

    expect(result.didCompact).toBe(false);
    expect(result.summary).toBe('');
    expect(result.messages).toEqual(history);
  });

  it('compacts once older messages exceed the old-history budget even if summary threshold is higher', () => {
    const history = [
      message('user', 'older context '.repeat(5).trim()),
      message('assistant', 'reply context '.repeat(5).trim()),
      message('user', 'recent question'),
      message('assistant', 'recent answer')
    ];

    const result = pruneHistoryForContext(history, {
      recentMessageCount: 2,
      oldHistoryBudgetChars: 60,
      summaryMaxLines: 4,
      summaryMaxChars: 120,
      summarySnippetLength: 24
    });

    expect(result.didCompact).toBe(true);
    expect(result.summary).toBe([
      'History summary:',
      '- user: older context older co…',
      '- assistant: reply context reply co…'
    ].join('\n'));
    expect(result.messages).toEqual([
      message('user', 'recent question'),
      message('assistant', 'recent answer')
    ]);
  });
});

describe('buildPromptWithContext', () => {
  it('combines stable prompt parts into the system prompt and keeps memory as a separate user message', () => {
    const result = buildPromptWithContext({
      baseSystemPrompt: 'You are a focused coding assistant.',
      memoryText: 'Memory:\n- User prefers Vietnamese.',
      skillsText: 'Skills:\n- Use TDD.',
      historySummary: 'History summary:\n- user: asked for Task 5.',
      history: [
        message('user', 'Please continue Task 5.'),
        message('assistant', 'I will start with tests.')
      ]
    });

    expect(result.systemPrompt).toBe([
      'You are a focused coding assistant.',
      'Skills:\n- Use TDD.',
      'History summary:\n- user: asked for Task 5.'
    ].join('\n\n'));
    expect(result.messages).toEqual([
      message('system', result.systemPrompt),
      message('user', 'Memory:\n- User prefers Vietnamese.'),
      message('user', 'Please continue Task 5.'),
      message('assistant', 'I will start with tests.')
    ]);
  });

  it('assembles the summary exactly once when used with pruneHistoryForContext output', () => {
    const pruned = pruneHistoryForContext([
      message('user', 'Older requirement details that exceed the compacting threshold.'),
      message('assistant', 'Older reasoning details that also exceed the compacting threshold.'),
      message('user', 'Most recent request'),
      message('assistant', 'Most recent response')
    ], {
      recentMessageCount: 2,
      oldHistoryBudgetChars: 40,
      summaryMaxLines: 4,
      summaryMaxChars: 120,
      summarySnippetLength: 24
    });

    const prompt = buildPromptWithContext({
      baseSystemPrompt: 'Base system prompt',
      historySummary: pruned.summary,
      history: pruned.messages
    });

    expect(pruned.messages[0]).toEqual(message('user', 'Most recent request'));
    expect(prompt.systemPrompt).toBe('Base system prompt\n\nHistory summary:\n- user: Older requirement deta…\n- assistant: Older reasoning detail…');
    expect(prompt.messages).toEqual([
      message('system', prompt.systemPrompt),
      message('user', 'Most recent request'),
      message('assistant', 'Most recent response')
    ]);
    expect(prompt.messages.filter((entry) => entry.role === 'system')).toHaveLength(1);
  });

  it('places memory immediately after the system prompt and before all recent history', () => {
    const result = buildPromptWithContext({
      baseSystemPrompt: 'Base system prompt',
      memoryText: 'Memory:\n- stable recalled fact',
      historySummary: 'History summary:\n- older context',
      history: [
        message('user', 'Recent user question'),
        message('assistant', 'Recent assistant reply'),
        message('user', 'Newest user follow-up')
      ]
    });

    expect(result.messages).toEqual([
      message('system', 'Base system prompt\n\nHistory summary:\n- older context'),
      message('user', 'Memory:\n- stable recalled fact'),
      message('user', 'Recent user question'),
      message('assistant', 'Recent assistant reply'),
      message('user', 'Newest user follow-up')
    ]);
  });
});
