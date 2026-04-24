import { describe, expect, it } from 'vitest';

import { matchBlueprints } from '../../src/blueprint/matcher.js';
import type { BlueprintRecord } from '../../src/blueprint/types.js';

function createBlueprint(overrides: Partial<BlueprintRecord> = {}): BlueprintRecord {
  return {
    id: 'bp_deploy_rollback',
    title: 'Deploy rollback investigation',
    goal: 'Handle deploy rollback requests safely.',
    trigger: {
      title: 'Deploy rollback',
      patterns: ['deploy rollback', 'rollback deploy', 'revert deployment'],
      tags: ['deploy', 'rollback']
    },
    preconditions: [],
    steps: [
      {
        id: 'inspect_logs',
        title: 'Inspect logs',
        instruction: 'Read deployment logs before taking action.',
        kind: 'inspect'
      }
    ],
    branches: [],
    expectedEvidence: [
      { description: 'Deployment logs reviewed.', kind: 'tool_result', required: true }
    ],
    failureModes: [],
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

describe('matchBlueprints', () => {
  it('matches active blueprints by trigger pattern overlap and returns reasons', () => {
    const matches = matchBlueprints({
      userInput: 'Please help me do a deploy rollback safely.',
      blueprints: [createBlueprint()]
    });

    expect(matches[0]).toEqual(expect.objectContaining({
      blueprint: expect.objectContaining({ id: 'bp_deploy_rollback' }),
      score: expect.any(Number),
      reasons: expect.arrayContaining([expect.stringContaining('pattern')])
    }));
    expect(matches[0]?.score).toBeGreaterThan(0);
  });

  it('does not return retired or superseded blueprints as normal active matches', () => {
    const matches = matchBlueprints({
      userInput: 'Please help me do a deploy rollback safely.',
      blueprints: [
        createBlueprint({ id: 'bp_active', status: 'active' }),
        createBlueprint({ id: 'bp_superseded', status: 'superseded' }),
        createBlueprint({ id: 'bp_retired', status: 'retired' })
      ]
    });

    expect(matches.map((match) => match.blueprint.id)).toEqual(['bp_active']);
  });
});
