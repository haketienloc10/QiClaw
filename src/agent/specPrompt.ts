import type { AgentSpec } from './spec.js';

export function renderAgentSystemPrompt(spec: AgentSpec): string {
  const sections = [
    'You are an agent operating inside the QiClaw runtime.',
    renderIdentitySection(spec),
    renderCapabilitiesSection(spec),
    renderPoliciesSection(spec),
    renderCompletionSection(spec),
    renderContextSection(spec),
    renderDiagnosticsSection(spec)
  ].filter((section) => section.length > 0);

  return sections.join('\n\n');
}

function renderIdentitySection(spec: AgentSpec): string {
  return [
    'Identity:',
    `- Purpose: ${spec.identity.purpose}`,
    `- Behavioral framing: ${spec.identity.behavioralFraming}`,
    `- Scope boundary: ${spec.identity.scopeBoundary}`
  ].join('\n');
}

function renderCapabilitiesSection(spec: AgentSpec): string {
  return [
    'Capabilities:',
    `- Allowed capability classes: ${spec.capabilities.allowedCapabilityClasses.join(', ')}`,
    `- Operating surface: ${spec.capabilities.operatingSurface}`,
    `- Capability exclusions: ${spec.capabilities.capabilityExclusions.join('; ')}`
  ].join('\n');
}

function renderPoliciesSection(spec: AgentSpec): string {
  return [
    'Policies:',
    `- Safety stance: ${spec.policies.safetyStance}`,
    `- Tool-use policy: ${spec.policies.toolUsePolicy}`,
    `- Escalation policy: ${spec.policies.escalationPolicy}`,
    `- Mutation policy: ${spec.policies.mutationPolicy}`
  ].join('\n');
}

function renderCompletionSection(spec: AgentSpec): string {
  return [
    'Completion:',
    `- Completion mode: ${spec.completion.completionMode}`,
    `- Done criteria shape: ${spec.completion.doneCriteriaShape}`,
    `- Evidence requirement: ${spec.completion.evidenceRequirement}`,
    `- Stop-vs-done distinction: ${spec.completion.stopVsDoneDistinction}`
  ].join('\n');
}

function renderContextSection(spec: AgentSpec): string {
  if (!spec.contextProfile) {
    return '';
  }

  const hints = spec.contextProfile.priorityHints?.join('; ');

  return [
    'Context profile:',
    `- Include memory: ${spec.contextProfile.includeMemory === true ? 'yes' : 'no'}`,
    `- Include skills: ${spec.contextProfile.includeSkills === true ? 'yes' : 'no'}`,
    `- Include history summary: ${spec.contextProfile.includeHistorySummary === true ? 'yes' : 'no'}`,
    hints ? `- Priority hints: ${hints}` : ''
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

function renderDiagnosticsSection(spec: AgentSpec): string {
  if (!spec.diagnosticsProfile) {
    return '';
  }

  return [
    'Diagnostics profile:',
    `- Participation level: ${spec.diagnosticsProfile.diagnosticsParticipationLevel}`,
    spec.diagnosticsProfile.traceabilityExpectation
      ? `- Traceability expectation: ${spec.diagnosticsProfile.traceabilityExpectation}`
      : '',
    spec.diagnosticsProfile.redactionSensitivity
      ? `- Redaction sensitivity: ${spec.diagnosticsProfile.redactionSensitivity}`
      : ''
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}
