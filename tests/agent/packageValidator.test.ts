import { describe, expect, it } from 'vitest';

import {
  validateAgentPackageExtendsCycle,
  validateAgentPackageExtendsTarget,
  validateLoadedAgentPackage,
  validateResolvedAgentPackage
} from '../../src/agent/packageValidator.js';
import type { LoadedAgentPackage } from '../../src/agent/spec.js';

function createLoadedPackage(overrides: Partial<LoadedAgentPackage> = {}): LoadedAgentPackage {
  return {
    preset: 'reviewer',
    sourceTier: 'project',
    directoryPath: '/tmp/reviewer',
    manifestPath: '/tmp/reviewer/agent.json',
    manifest: {
      policy: {
        allowedCapabilityClasses: ['read', 'search'],
        maxToolRounds: 3,
        mutationMode: 'none'
      }
    },
    promptFiles: {
      'AGENT.md': {
        filePath: '/tmp/reviewer/AGENT.md',
        content: 'You are a reviewer.'
      }
    },
    ...overrides
  };
}

describe('packageValidator', () => {
  it('reports when agent.json is missing', () => {
    expect(validateLoadedAgentPackage(createLoadedPackage({ manifest: undefined }))).toEqual([
      'Agent package "reviewer" is missing agent.json.'
    ]);
  });

  it('reports when a base package is missing AGENT.md', () => {
    expect(validateLoadedAgentPackage(createLoadedPackage({ promptFiles: {} }))).toEqual([
      'Base package "reviewer" must provide AGENT.md.'
    ]);
  });

  it('reports invalid capability classes declared in the manifest', () => {
    expect(
      validateLoadedAgentPackage(
        createLoadedPackage({
          manifest: {
            policy: {
              allowedCapabilityClasses: ['read', 'dance'] as never,
              maxToolRounds: 3,
              mutationMode: 'none'
            }
          }
        })
      )
    ).toEqual(['Agent package "reviewer" declares invalid capability class "dance".']);
  });

  it('reports malformed manifest field types before downstream validation uses them', () => {
    expect(
      validateLoadedAgentPackage(
        createLoadedPackage({
          manifest: {
            extends: 123 as never,
            policy: {
              allowedCapabilityClasses: 'read' as never,
              maxToolRounds: '3' as never,
              mutationMode: 'dangerous' as never,
              includeMemory: 'yes' as never,
              includeSkills: 1 as never,
              includeHistorySummary: null as never,
              requiresToolEvidence: 'yes' as never,
              requiresSubstantiveFinalAnswer: 1 as never,
              forbidSuccessAfterToolErrors: null as never,
              diagnosticsParticipationLevel: 'verbose' as never,
              redactionSensitivity: 'low' as never
            }
          }
        })
      )
    ).toEqual([
      'Agent package "reviewer" must set extends to a string when provided.',
      'Agent package "reviewer" must set allowedCapabilityClasses to an array when provided.',
      'Agent package "reviewer" must set maxToolRounds to a positive integer when provided.',
      'Agent package "reviewer" declares invalid mutationMode "dangerous".',
      'Agent package "reviewer" must set includeMemory to a boolean when provided.',
      'Agent package "reviewer" must set includeSkills to a boolean when provided.',
      'Agent package "reviewer" must set includeHistorySummary to a boolean when provided.',
      'Agent package "reviewer" must set requiresToolEvidence to a boolean when provided.',
      'Agent package "reviewer" must set requiresSubstantiveFinalAnswer to a boolean when provided.',
      'Agent package "reviewer" must set forbidSuccessAfterToolErrors to a boolean when provided.',
      'Agent package "reviewer" declares invalid diagnosticsParticipationLevel "verbose".',
      'Agent package "reviewer" declares invalid redactionSensitivity "low".'
    ]);
  });

  it('reports when manifest is not a plain object', () => {
    expect(validateLoadedAgentPackage(createLoadedPackage({ manifest: [] as never }))).toEqual([
      'Agent package "reviewer" must define agent.json as a plain object.'
    ]);
    expect(validateLoadedAgentPackage(createLoadedPackage({ manifest: 'bad' as never }))).toEqual([
      'Agent package "reviewer" must define agent.json as a plain object.'
    ]);
    expect(validateLoadedAgentPackage(createLoadedPackage({ manifest: 123 as never }))).toEqual([
      'Agent package "reviewer" must define agent.json as a plain object.'
    ]);
    expect(validateLoadedAgentPackage(createLoadedPackage({ manifest: null as never }))).toEqual([
      'Agent package "reviewer" must define agent.json as a plain object.'
    ]);
  });

  it('reports when policy is not a plain object', () => {
    expect(
      validateLoadedAgentPackage(
        createLoadedPackage({
          manifest: {
            policy: [] as never
          }
        })
      )
    ).toEqual(['Agent package "reviewer" must set policy to a plain object when provided.']);

    expect(
      validateLoadedAgentPackage(
        createLoadedPackage({
          manifest: {
            policy: 'bad' as never
          }
        })
      )
    ).toEqual(['Agent package "reviewer" must set policy to a plain object when provided.']);

    expect(
      validateLoadedAgentPackage(
        createLoadedPackage({
          manifest: {
            policy: 123 as never
          }
        })
      )
    ).toEqual(['Agent package "reviewer" must set policy to a plain object when provided.']);

    expect(
      validateLoadedAgentPackage(
        createLoadedPackage({
          manifest: {
            policy: null as never
          }
        })
      )
    ).toEqual(['Agent package "reviewer" must set policy to a plain object when provided.']);
  });

  it('reports when extends is empty or whitespace only', () => {
    expect(
      validateLoadedAgentPackage(
        createLoadedPackage({
          manifest: {
            extends: ''
          },
          promptFiles: {}
        })
      )
    ).toEqual(['Agent package "reviewer" must set extends to a non-empty string when provided.']);

    expect(
      validateLoadedAgentPackage(
        createLoadedPackage({
          manifest: {
            extends: '   '
          },
          promptFiles: {}
        })
      )
    ).toEqual(['Agent package "reviewer" must set extends to a non-empty string when provided.']);
  });

  it('reports unresolved extends targets at validator level', () => {
    expect(validateAgentPackageExtendsTarget('reviewer', 'missing-base')).toEqual([
      'Agent package "reviewer" extends unknown package "missing-base".'
    ]);
  });

  it('reports extends cycles at validator level', () => {
    expect(validateAgentPackageExtendsCycle(['alpha', 'beta'], 'alpha')).toEqual([
      'Detected agent package extends cycle: alpha -> beta -> alpha'
    ]);
  });

  it('reports invalid effective runtime policy combinations after inheritance', () => {
    expect(
      validateResolvedAgentPackage({
        preset: 'reviewer',
        sourceTier: 'project',
        extendsChain: ['reviewer', 'readonly'],
        packageChain: [],
        effectivePolicy: {
          allowedCapabilityClasses: ['read', 'write'],
          maxToolRounds: 0,
          mutationMode: 'none'
        },
        effectivePromptFiles: {},
        resolvedFiles: []
      })
    ).toEqual([
      'Agent package "reviewer" must set maxToolRounds to at least 1.',
      'Agent package "reviewer" cannot allow write or execute capabilities when mutationMode is "none".'
    ]);
  });
});
