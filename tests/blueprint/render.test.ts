import { describe, expect, it } from 'vitest';

import { renderBlueprintContext } from '../../src/blueprint/render.js';
import type { BlueprintMatch, BlueprintRecord } from '../../src/blueprint/types.js';

function createBlueprint(overrides: Partial<BlueprintRecord> = {}): BlueprintRecord {
  return {
    id: 'bp_deploy_rollback',
    title: 'Deploy rollback investigation',
    goal: 'Handle deploy rollback requests safely.',
    trigger: {
      title: 'Deploy rollback',
      patterns: ['deploy rollback'],
      tags: ['deploy', 'rollback']
    },
    preconditions: [],
    steps: [
      {
        id: 'inspect_logs',
        title: 'Inspect logs',
        instruction: 'Read deployment logs before taking action.',
        kind: 'inspect'
      },
      {
        id: 'verify_state',
        title: 'Verify deployment state',
        instruction: 'Confirm the current deployment before rollback.',
        kind: 'verify'
      }
    ],
    branches: [],
    expectedEvidence: [
      { description: 'Deployment logs reviewed.', kind: 'tool_result', required: true }
    ],
    failureModes: [
      { title: 'Rollback without evidence', signals: ['no logs checked'], mitigation: 'Inspect logs first.' }
    ],
    tags: ['deploy', 'rollback'],
    source: 'fixture:test',
    createdAt: '2026-04-23T10:00:00.000Z',
    updatedAt: '2026-04-23T10:00:00.000Z',
    status: 'active',
    stats: {
      useCount: 0,
      successCount: 0,
      failureCount: 0
    },
    ...overrides
  };
}

function createMatch(overrides: Partial<BlueprintMatch> = {}): BlueprintMatch {
  return {
    blueprint: createBlueprint(),
    score: 0.92,
    reasons: ['pattern overlap: deploy rollback'],
    ...overrides
  };
}

describe('renderBlueprintContext', () => {
  it('renders a concise procedural context with steps and evidence requirements', () => {
    const rendered = renderBlueprintContext({
      matches: [createMatch()],
      budgetChars: 800
    });

    expect(rendered).toContain('Blueprint');
    expect(rendered).toContain('Deploy rollback investigation');
    expect(rendered).toContain('Inspect logs');
    expect(rendered).toContain('Verify deployment state');
    expect(rendered).toContain('Deployment logs reviewed.');
    expect(rendered).not.toContain('"trigger"');
  });

  it('returns an empty string when there is no matched blueprint', () => {
    expect(renderBlueprintContext({ matches: [], budgetChars: 400 })).toBe('');
  });
});
