import { describe, expect, it } from 'vitest';

import { parseSpecialistArtifact } from '../../src/specialist/parser.js';

describe('parseSpecialistArtifact', () => {
  it('parses structured research artifacts', () => {
    const artifact = parseSpecialistArtifact(
      'research',
      JSON.stringify({
        kind: 'research',
        summary: 'Mapped the auth flow.',
        confidence: 0.81,
        suggestedNextSteps: ['Review the session boundary.'],
        findings: ['The login request goes through authService.'],
        openQuestions: ['How are refresh tokens rotated?'],
        evidence: ['src/auth/service.ts']
      })
    );

    expect(artifact.kind).toBe('research');
    expect(artifact.summary).toBe('Mapped the auth flow.');
    expect(artifact.findings).toEqual(['The login request goes through authService.']);
  });

  it('falls back gracefully when structured parsing fails', () => {
    const artifact = parseSpecialistArtifact('debug', 'Raw specialist output that is not JSON.');

    expect(artifact.kind).toBe('debug');
    expect(artifact.summary).toMatch(/could not parse/i);
    expect(artifact.confidence).toBe(0.2);
    expect(artifact.proposedFixes).toEqual([]);
    expect(artifact.suggestedNextSteps.length).toBeGreaterThan(0);
  });
});
