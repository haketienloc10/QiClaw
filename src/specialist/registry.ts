import type { SpecialistDefinition, SpecialistKind } from './types.js';

const specialistOutputContract = [
  'Return exactly one JSON object with the fields required for your specialist kind.',
  'Do not wrap the JSON in markdown fences.',
  'Keep summary concise and evidence concrete.'
].join(' ');

const specialistDefinitions = [
  {
    kind: 'research',
    slashCommand: '/research',
    heuristicPatterns: [
      /\bfind\b/i,
      /\banaly[sz]e\b/i,
      /\binvestigate\b/i,
      /\bsummarize codebase\b/i,
      /\bread\b/i,
      /\bcompare\b/i
    ],
    systemPrompt: [
      'You are the Research specialist.',
      'Work only from the provided brief and evidence snippets.',
      'Do not mutate code or propose edits as if already applied.',
      specialistOutputContract
    ].join(' '),
    toolPolicy: {
      allowedCapabilityClasses: ['read']
    }
  },
  {
    kind: 'debug',
    slashCommand: '/debug',
    heuristicPatterns: [
      /\bbug\b/i,
      /\berror\b/i,
      /\bstack trace\b/i,
      /\broot cause\b/i,
      /\bfailing\b/i,
      /\bcrash\b/i
    ],
    systemPrompt: [
      'You are the Debug specialist.',
      'Investigate likely causes from the provided brief and evidence only.',
      'Do not claim fixes were applied.',
      specialistOutputContract
    ].join(' '),
    toolPolicy: {
      allowedCapabilityClasses: ['read']
    }
  },
  {
    kind: 'review',
    slashCommand: '/review',
    heuristicPatterns: [
      /\breview diff\b/i,
      /\breview patch\b/i,
      /\breview\b/i,
      /\bcheck invariant\b/i,
      /\bregression\b/i,
      /\brisk scan\b/i
    ],
    systemPrompt: [
      'You are the Review specialist.',
      'Assess findings, blocking issues, and verdict from the provided brief only.',
      'Keep the review bounded and concrete.',
      specialistOutputContract
    ].join(' '),
    toolPolicy: {
      allowedCapabilityClasses: ['read']
    }
  }
] satisfies SpecialistDefinition[];

const definitionsByKind = new Map<SpecialistKind, SpecialistDefinition>(
  specialistDefinitions.map((definition) => [definition.kind, definition])
);

export function getSpecialistDefinition(kind: SpecialistKind): SpecialistDefinition {
  const definition = definitionsByKind.get(kind);
  if (!definition) {
    throw new Error(`Unknown specialist kind: ${kind}`);
  }

  return definition;
}

export function getSpecialistDefinitions(): SpecialistDefinition[] {
  return [...specialistDefinitions];
}
