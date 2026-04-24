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
    if (artifact.kind !== 'research') {
      throw new Error('expected research artifact');
    }
    expect(artifact.summary).toBe('Mapped the auth flow.');
    expect(artifact.findings).toEqual(['The login request goes through authService.']);
  });

  it('parses debug artifacts wrapped in markdown fences', () => {
    const artifact = parseSpecialistArtifact(
      'debug',
      [
        '```json',
        JSON.stringify({
          kind: 'debug',
          summary: 'Likely caused by a stale cache key.',
          confidence: 0.84,
          suggestedNextSteps: ['Invalidate the stale key.', 'Re-run the failing request.'],
          likelyCauses: [
            {
              title: 'Stale cache key',
              confidence: 0.84,
              evidence: ['Observed outdated payload after a successful write.']
            }
          ],
          evidence: ['Cache layer returned an older version of the record.'],
          proposedFixes: ['Invalidate the cache entry on write.'],
          unresolvedRisks: ['Other endpoints may reuse the same stale key.']
        }),
        '```'
      ].join('\n')
    );

    expect(artifact.kind).toBe('debug');
    if (artifact.kind !== 'debug') {
      throw new Error('expected debug artifact');
    }
    expect(artifact.summary).toBe('Likely caused by a stale cache key.');
    expect(artifact.likelyCauses).toHaveLength(1);
    expect(artifact.proposedFixes).toEqual(['Invalidate the cache entry on write.']);
  });

  it('parses debug artifacts when the JSON object is surrounded by extra prose', () => {
    const artifact = parseSpecialistArtifact(
      'debug',
      [
        'Here is the structured artifact you asked for:',
        JSON.stringify({
          kind: 'debug',
          summary: 'The crash likely comes from undefined config.',
          confidence: 0.73,
          suggestedNextSteps: ['Guard the config read.', 'Add a regression test.'],
          likelyCauses: [
            {
              title: 'Undefined config value',
              confidence: 0.73,
              evidence: ['Stack trace points at reading `config.api.baseUrl`.']
            }
          ],
          evidence: ['The process starts without the expected env var.'],
          proposedFixes: ['Fail fast when config is incomplete.'],
          unresolvedRisks: ['Other config reads may have the same assumption.']
        }),
        'Let me know if you want a patch proposal too.'
      ].join('\n')
    );

    expect(artifact.kind).toBe('debug');
    if (artifact.kind !== 'debug') {
      throw new Error('expected debug artifact');
    }
    expect(artifact.summary).toBe('The crash likely comes from undefined config.');
    expect(artifact.evidence).toEqual(['The process starts without the expected env var.']);
    expect(artifact.unresolvedRisks).toEqual(['Other config reads may have the same assumption.']);
  });

  it('coerces review artifacts that use issue instead of title and omit kind', () => {
    const artifact = parseSpecialistArtifact(
      'review',
      JSON.stringify({
        summary: 'Có dấu hiệu lỗi nghiêm trọng đang chặn flow debug: assistant trả về đúng chuỗi lỗi parse thay vì artifact có cấu trúc.',
        findings: [
          {
            severity: 'high',
            issue: 'Flow specialist/debug hiện thất bại ở bước parse output thành structured artifact.',
            evidence: [
              'Với lệnh /debug..., assistant trả lời trực tiếp chuỗi lỗi parse.',
              'Với lệnh debug bug..., assistant tiếp tục trả về cùng chuỗi lỗi.'
            ],
            blocking: true
          }
        ],
        verdict: 'reject'
      })
    );

    expect(artifact.kind).toBe('review');
    if (artifact.kind !== 'review') {
      throw new Error('expected review artifact');
    }
    expect(artifact.summary).toContain('dấu hiệu lỗi nghiêm trọng');
    expect(artifact.findings).toEqual([
      {
        severity: 'high',
        title: 'Flow specialist/debug hiện thất bại ở bước parse output thành structured artifact.',
        details: 'Với lệnh /debug..., assistant trả lời trực tiếp chuỗi lỗi parse.\nVới lệnh debug bug..., assistant tiếp tục trả về cùng chuỗi lỗi.'
      }
    ]);
    expect(artifact.blockingIssues).toEqual([
      'Flow specialist/debug hiện thất bại ở bước parse output thành structured artifact.'
    ]);
    expect(artifact.nonBlockingIssues).toEqual([]);
    expect(artifact.verdict).toBe('changes_requested');
  });

  it('coerces review artifacts whose finding evidence is a single string', () => {
    const artifact = parseSpecialistArtifact(
      'review',
      JSON.stringify({
        summary: 'Không có đủ bằng chứng để review bản vá hiện tại.',
        findings: [
          {
            severity: 'medium',
            file: 'review-brief',
            line: 1,
            title: 'Brief không xác định patch cần review',
            evidence: 'Brief chỉ nêu kiểm tra bản vá hiện tại nhưng không chỉ ra commit, diff, hay danh sách file thay đổi.'
          }
        ],
        verdict: 'needs_followup'
      })
    );

    expect(artifact.kind).toBe('review');
    if (artifact.kind !== 'review') {
      throw new Error('expected review artifact');
    }
    expect(artifact.summary).toBe('Không có đủ bằng chứng để review bản vá hiện tại.');
    expect(artifact.findings).toEqual([
      {
        severity: 'medium',
        title: 'Brief không xác định patch cần review',
        details: 'Brief chỉ nêu kiểm tra bản vá hiện tại nhưng không chỉ ra commit, diff, hay danh sách file thay đổi.'
      }
    ]);
    expect(artifact.nonBlockingIssues).toEqual(['Brief không xác định patch cần review']);
    expect(artifact.verdict).toBe('needs_followup');
  });

  it('falls back gracefully when structured parsing fails', () => {
    const artifact = parseSpecialistArtifact('debug', 'Raw specialist output that is not JSON.');

    expect(artifact.kind).toBe('debug');
    if (artifact.kind !== 'debug') {
      throw new Error('expected debug artifact');
    }
    expect(artifact.summary).toMatch(/could not parse/i);
    expect(artifact.confidence).toBe(0.2);
    expect(artifact.proposedFixes).toEqual([]);
    expect(artifact.suggestedNextSteps.length).toBeGreaterThan(0);
  });
});
