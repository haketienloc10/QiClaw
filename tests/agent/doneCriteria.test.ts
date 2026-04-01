import { describe, expect, it } from 'vitest';

import type { Message } from '../../src/core/types.js';
import type { ToolResultMessage } from '../../src/provider/model.js';
import { buildDoneCriteria } from '../../src/agent/doneCriteria.js';
import { verifyAgentTurn } from '../../src/agent/verifier.js';

describe('done criteria', () => {
  it('builds deterministic criteria for a simple goal', () => {
    expect(buildDoneCriteria('Answer with a short greeting.')).toEqual({
      goal: 'Answer with a short greeting.',
      checklist: ['Answer with a short greeting.'],
      requiresNonEmptyFinalAnswer: true,
      requiresToolEvidence: false,
      toolEvidenceReason: undefined
    });
  });

  it('splits a compound goal into a deterministic checklist and requires tool evidence for inspection goals', () => {
    expect(buildDoneCriteria('Read package.json and summarize scripts, then inspect tests')).toEqual({
      goal: 'Read package.json and summarize scripts, then inspect tests',
      checklist: ['Read package.json', 'summarize scripts', 'inspect tests'],
      requiresNonEmptyFinalAnswer: true,
      requiresToolEvidence: true,
      toolEvidenceReason: 'Goal asks for workspace inspection via read/search/check/review actions.'
    });
  });

  it('does not require tool evidence for purely linguistic review wording', () => {
    expect(buildDoneCriteria('Review this answer and shorten it.')).toEqual({
      goal: 'Review this answer and shorten it.',
      checklist: ['Review this answer', 'shorten it.'],
      requiresNonEmptyFinalAnswer: true,
      requiresToolEvidence: false,
      toolEvidenceReason: undefined
    });
  });
});

describe('verifier', () => {
  it('passes when the final answer is non-empty and no tool evidence is required', () => {
    const result = verifyAgentTurn({
      criteria: buildDoneCriteria('Answer with a short greeting.'),
      finalAnswer: 'Hello there.',
      history: [
        { role: 'user', content: 'Say hi' },
        { role: 'assistant', content: 'Hello there.' }
      ]
    });

    expect(result).toEqual({
      isVerified: true,
      finalAnswerIsNonEmpty: true,
      toolEvidenceSatisfied: true,
      toolMessagesCount: 0,
      checks: [
        {
          name: 'turn_completed',
          passed: true,
          details: 'Agent turn reached a provider stop with no remaining tool calls.'
        },
        {
          name: 'final_answer_non_empty',
          passed: true,
          details: 'Final answer is non-empty.'
        },
        {
          name: 'tool_evidence',
          passed: true,
          details: 'Tool evidence not required for this goal.'
        }
      ]
    });
  });

  it('fails when the goal requires inspection but no tool message exists', () => {
    const result = verifyAgentTurn({
      criteria: buildDoneCriteria('Search the repo and explain the result'),
      finalAnswer: 'I found the answer.',
      history: [
        { role: 'user', content: 'Search the repo and explain the result' },
        { role: 'assistant', content: 'I found the answer.' }
      ]
    });

    expect(result).toEqual({
      isVerified: false,
      finalAnswerIsNonEmpty: true,
      toolEvidenceSatisfied: false,
      toolMessagesCount: 0,
      checks: [
        {
          name: 'turn_completed',
          passed: true,
          details: 'Agent turn reached a provider stop with no remaining tool calls.'
        },
        {
          name: 'final_answer_non_empty',
          passed: true,
          details: 'Final answer is non-empty.'
        },
        {
          name: 'tool_evidence',
          passed: false,
          details: 'Expected at least one tool message because: Goal asks for workspace inspection via read/search/check/review actions.'
        }
      ]
    });
  });

  it('passes when tool evidence exists for an inspection goal', () => {
    const history = [
      { role: 'user', content: 'Inspect the file and explain the result' },
      { role: 'assistant', content: 'I will inspect the file.' },
      {
        role: 'tool',
        name: 'read_file',
        toolCallId: 'call-1',
        content: 'one line',
        isError: false
      } satisfies ToolResultMessage,
      { role: 'assistant', content: 'The file contains one line.' }
    ] satisfies Array<Message | ToolResultMessage>;

    const result = verifyAgentTurn({
      criteria: buildDoneCriteria('Inspect the file and explain the result'),
      finalAnswer: 'The file contains one line.',
      history: history as Message[]
    });

    expect(result).toEqual({
      isVerified: true,
      finalAnswerIsNonEmpty: true,
      toolEvidenceSatisfied: true,
      toolMessagesCount: 1,
      checks: [
        {
          name: 'turn_completed',
          passed: true,
          details: 'Agent turn reached a provider stop with no remaining tool calls.'
        },
        {
          name: 'final_answer_non_empty',
          passed: true,
          details: 'Final answer is non-empty.'
        },
        {
          name: 'tool_evidence',
          passed: true,
          details: 'Observed 1 tool message(s) for an inspection-style goal.'
        }
      ]
    });
  });

  it('does not count tool errors as satisfying inspection evidence', () => {
    const history = [
      { role: 'user', content: 'Inspect the file and explain the result' },
      { role: 'assistant', content: 'I will inspect the file.' },
      {
        role: 'tool',
        name: 'read_file',
        toolCallId: 'call-1',
        content: 'missing.txt',
        isError: true
      } satisfies ToolResultMessage,
      { role: 'assistant', content: 'I could not inspect the file.' }
    ] satisfies Array<Message | ToolResultMessage>;

    const result = verifyAgentTurn({
      criteria: buildDoneCriteria('Inspect the file and explain the result'),
      finalAnswer: 'I could not inspect the file.',
      history: history as Message[]
    });

    expect(result).toEqual({
      isVerified: false,
      finalAnswerIsNonEmpty: true,
      toolEvidenceSatisfied: false,
      toolMessagesCount: 0,
      checks: [
        {
          name: 'turn_completed',
          passed: true,
          details: 'Agent turn reached a provider stop with no remaining tool calls.'
        },
        {
          name: 'final_answer_non_empty',
          passed: true,
          details: 'Final answer is non-empty.'
        },
        {
          name: 'tool_evidence',
          passed: false,
          details: 'Expected at least one tool message because: Goal asks for workspace inspection via read/search/check/review actions.'
        }
      ]
    });
  });
});
